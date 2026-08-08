use std::{
    collections::VecDeque,
    fs,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, Message},
};

use super::{is_running, secret, CONTROLLER};

const EVENT: &str = "mihomo-traffic";
const RETRY_DELAY: Duration = Duration::from_secs(2);

#[derive(Default)]
pub struct TrafficStreamState {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficPoint {
    pub timestamp: u64,
    pub up: u64,
    pub down: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSnapshot {
    pub timestamp: u64,
    pub up: u64,
    pub down: u64,
    pub today_up: u64,
    pub today_down: u64,
    pub history: Vec<TrafficPoint>,
}

#[derive(Debug, Deserialize)]
struct IncomingTraffic {
    #[serde(default)]
    up: f64,
    #[serde(default)]
    down: f64,
    #[serde(rename = "upTotal")]
    up_total: Option<u64>,
    #[serde(rename = "downTotal")]
    down_total: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTotals {
    day: u64,
    up: u64,
    down: u64,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn today_key() -> u64 {
    now_millis() / 86_400_000
}

fn totals_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|path| path.join("traffic-today.json"))
}

fn load_totals(app: &AppHandle) -> StoredTotals {
    let path = match totals_path(app) {
        Some(path) => path,
        None => {
            return StoredTotals {
                day: today_key(),
                up: 0,
                down: 0,
            }
        }
    };
    let stored = fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str::<StoredTotals>(&content).ok());
    match stored.filter(|totals| totals.day == today_key()) {
        Some(totals) => totals,
        None => StoredTotals {
            day: today_key(),
            up: 0,
            down: 0,
        },
    }
}

fn save_totals(app: &AppHandle, totals: &StoredTotals) {
    if let Some(path) = totals_path(app) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(content) = serde_json::to_vec(totals) {
            let _ = fs::write(path, content);
        }
    }
}

pub fn start(app: &AppHandle) {
    let state = app.state::<TrafficStreamState>();
    if let Ok(mut task) = state.task.lock() {
        if task.is_none() {
            *task = Some(tauri::async_runtime::spawn(run(app.clone())));
        }
    };
}

pub fn stop(app: &AppHandle) {
    let state = app.state::<TrafficStreamState>();
    if let Ok(mut task) = state.task.lock() {
        if let Some(handle) = task.take() {
            handle.abort();
        }
    };
}

async fn run(app: AppHandle) {
    loop {
        if !is_running().await {
            tokio::time::sleep(RETRY_DELAY).await;
            continue;
        }

        let request = match format!("ws://{CONTROLLER}/traffic").into_client_request() {
            Ok(mut request) => {
                request
                    .headers_mut()
                    .insert("Authorization", format!("Bearer {}", secret()).parse().unwrap());
                request
            }
            Err(_) => {
                tokio::time::sleep(RETRY_DELAY).await;
                continue;
            }
        };

        match connect_async(request).await {
            Ok((mut socket, _)) => {
                let mut totals = load_totals(&app);
                let mut history = VecDeque::<TrafficPoint>::new();
                let mut last_sample = Instant::now();
                let mut last_save = Instant::now();
                let mut previous_totals: Option<(u64, u64)> = None;
                while let Some(message) = socket.next().await {
                    let message = match message {
                        Ok(message) => message,
                        Err(_) => break,
                    };
                    let text = match message {
                        Message::Text(text) => text,
                        Message::Close(_) => break,
                        _ => continue,
                    };
                    let incoming = match serde_json::from_str::<IncomingTraffic>(text.as_ref()) {
                        Ok(value) => value,
                        Err(_) => continue,
                    };
                    let elapsed = last_sample.elapsed().as_secs_f64().clamp(0.0, 5.0);
                    last_sample = Instant::now();
                    if let (Some(up_total), Some(down_total)) =
                        (incoming.up_total, incoming.down_total)
                    {
                        if let Some((previous_up, previous_down)) = previous_totals {
                            totals.up = totals
                                .up
                                .saturating_add(up_total.saturating_sub(previous_up));
                            totals.down = totals
                                .down
                                .saturating_add(down_total.saturating_sub(previous_down));
                        }
                        previous_totals = Some((up_total, down_total));
                    } else {
                        totals.up = totals
                            .up
                            .saturating_add((incoming.up.max(0.0) * elapsed) as u64);
                        totals.down = totals
                            .down
                            .saturating_add((incoming.down.max(0.0) * elapsed) as u64);
                    }
                    let timestamp = now_millis();
                    history.push_back(TrafficPoint {
                        timestamp,
                        up: incoming.up.max(0.0) as u64,
                        down: incoming.down.max(0.0) as u64,
                    });
                    while history
                        .front()
                        .is_some_and(|point| timestamp.saturating_sub(point.timestamp) > 60_000)
                    {
                        history.pop_front();
                    }
                    if last_save.elapsed() >= Duration::from_secs(10) {
                        save_totals(&app, &totals);
                        last_save = Instant::now();
                    }
                    let snapshot = TrafficSnapshot {
                        timestamp,
                        up: incoming.up.max(0.0) as u64,
                        down: incoming.down.max(0.0) as u64,
                        today_up: totals.up,
                        today_down: totals.down,
                        history: history.iter().cloned().collect(),
                    };
                    let _ = app.emit(EVENT, snapshot);
                }
                save_totals(&app, &totals);
            }
            Err(_) => tokio::time::sleep(RETRY_DELAY).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::IncomingTraffic;

    #[test]
    fn accepts_mihomo_traffic_rates() {
        let payload: IncomingTraffic = serde_json::from_str(
            r#"{"up": 1370000, "down": 8420000, "upTotal": 13700000, "downTotal": 84200000}"#,
        )
        .expect("valid Mihomo traffic payload");
        assert_eq!(payload.up as u64, 1_370_000);
        assert_eq!(payload.down as u64, 8_420_000);
        assert_eq!(payload.up_total, Some(13_700_000));
        assert_eq!(payload.down_total, Some(84_200_000));
    }
}
