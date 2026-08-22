use std::{env, fs, path::PathBuf, process};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct TauriConfig {
    plugins: TauriPlugins,
}

#[derive(Debug, Deserialize)]
struct TauriPlugins {
    updater: TauriUpdater,
}

#[derive(Debug, Deserialize)]
struct TauriUpdater {
    pubkey: String,
}

struct Cli {
    artifact: PathBuf,
    signature: PathBuf,
    config: PathBuf,
}

fn usage() -> &'static str {
    "Usage: verify-updater-signature --artifact <path> --signature <path> --config <path>"
}

fn parse_cli() -> Result<Cli, String> {
    let mut artifact = None;
    let mut signature = None;
    let mut config = None;
    let mut args = env::args_os().skip(1);

    while let Some(argument) = args.next() {
        let option = argument.to_string_lossy();
        let mut value = || {
            args.next()
                .map(PathBuf::from)
                .ok_or_else(|| format!("Missing value for {option}.\n{}", usage()))
        };

        match option.as_ref() {
            "--artifact" => artifact = Some(value()?),
            "--signature" => signature = Some(value()?),
            "--config" => config = Some(value()?),
            "--help" | "-h" => return Err(usage().to_string()),
            _ => return Err(format!("Unknown option {option}.\n{}", usage())),
        }
    }

    Ok(Cli {
        artifact: artifact.ok_or_else(|| format!("Missing --artifact.\n{}", usage()))?,
        signature: signature.ok_or_else(|| format!("Missing --signature.\n{}", usage()))?,
        config: config.ok_or_else(|| format!("Missing --config.\n{}", usage()))?,
    })
}

fn decode_base64_text(value: &str, field: &str) -> Result<String, String> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|_| format!("{field} is not valid standard Base64."))?;
    String::from_utf8(decoded).map_err(|_| format!("{field} is not valid UTF-8."))
}

fn verify_artifact(
    artifact_path: &PathBuf,
    signature_path: &PathBuf,
    config_path: &PathBuf,
) -> Result<(), String> {
    let artifact = fs::read(artifact_path)
        .map_err(|error| format!("Unable to read updater artifact: {error}"))?;
    let config_text = fs::read_to_string(config_path)
        .map_err(|error| format!("Unable to read Tauri configuration: {error}"))?;
    let config: TauriConfig = serde_json::from_str(&config_text)
        .map_err(|error| format!("Unable to parse Tauri configuration: {error}"))?;

    let public_key_text = decode_base64_text(&config.plugins.updater.pubkey, "Updater public key")?;
    let public_key = PublicKey::decode(&public_key_text)
        .map_err(|error| format!("Updater public key is malformed: {error}"))?;

    let signature_base64 = fs::read_to_string(signature_path)
        .map_err(|error| format!("Unable to read updater signature: {error}"))?;
    let signature_base64 = signature_base64.trim();
    if signature_base64.is_empty() {
        return Err("Updater signature is empty.".to_string());
    }
    let signature_text = decode_base64_text(signature_base64, "Updater signature")?;
    let signature = Signature::decode(&signature_text)
        .map_err(|error| format!("Updater signature is malformed: {error}"))?;

    // This intentionally mirrors tauri-plugin-updater 2.10.1:
    // PublicKey::decode, Signature::decode, then verify(data, signature, true).
    public_key
        .verify(&artifact, &signature, true)
        .map_err(|error| {
            format!("Updater signature does not verify against the configured public key: {error}")
        })
}

fn main() {
    let cli = match parse_cli() {
        Ok(cli) => cli,
        Err(error) => {
            eprintln!("{error}");
            process::exit(2);
        }
    };

    if let Err(error) = verify_artifact(&cli.artifact, &cli.signature, &cli.config) {
        eprintln!("{error}");
        process::exit(1);
    }

    println!(
        "Tauri updater signature verified for {} using src-tauri/tauri.conf.json public-key semantics.",
        cli.artifact.display()
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PUBLIC_KEY: &str = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
    const TEST_SIGNATURE_TEXT: &str = "untrusted comment: signature from minisign secret key\n\
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n\
trusted comment: timestamp:1556193335\tfile:test\n\
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";

    fn encoded_test_public_key(raw_public_key: &str) -> String {
        STANDARD.encode(format!(
            "untrusted comment: minisign public key\n{raw_public_key}"
        ))
    }

    fn encoded_test_signature() -> String {
        STANDARD.encode(TEST_SIGNATURE_TEXT)
    }

    fn verify_fields(
        data: &[u8],
        public_key_base64: &str,
        signature_base64: &str,
    ) -> Result<(), String> {
        let public_key_text = decode_base64_text(public_key_base64, "Updater public key")?;
        let public_key = PublicKey::decode(&public_key_text).map_err(|error| error.to_string())?;
        let signature_text = decode_base64_text(signature_base64, "Updater signature")?;
        let signature = Signature::decode(&signature_text).map_err(|error| error.to_string())?;
        public_key
            .verify(data, &signature, true)
            .map_err(|error| error.to_string())
    }

    #[test]
    fn valid_tauri_style_signature_passes() {
        let public_key = encoded_test_public_key(TEST_PUBLIC_KEY);
        verify_fields(b"test", &public_key, &encoded_test_signature()).unwrap();
    }

    #[test]
    fn changing_one_artifact_byte_fails() {
        let mut changed = b"test".to_vec();
        changed[0] ^= 1;
        let public_key = encoded_test_public_key(TEST_PUBLIC_KEY);
        assert!(verify_fields(&changed, &public_key, &encoded_test_signature()).is_err());
    }

    #[test]
    fn wrong_public_key_fails() {
        let wrong_public_key = TEST_PUBLIC_KEY.replace("GFO3", "GFO2");
        let public_key = encoded_test_public_key(&wrong_public_key);
        assert!(verify_fields(b"test", &public_key, &encoded_test_signature()).is_err());
    }

    #[test]
    fn malformed_signature_fails() {
        let public_key = encoded_test_public_key(TEST_PUBLIC_KEY);
        assert!(verify_fields(b"test", &public_key, "not-a-signature").is_err());
    }
}
