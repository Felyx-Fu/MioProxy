import { Braces, Check, Eye, FileCode2, Save, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { mihomoApi, type ConfigPreview } from "../api/mihomo";

const EXAMPLE = "# MioProxy Local Override\n# 这里只放本地覆盖项，不会改写订阅源。\n# dns:\n#   enable: true\n";

export function OverridesPage({ profileId }: { profileId: string | null }) {
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await mihomoApi.overrideGet();
      const next = snapshot.content || "";
      setContent(next);
      setSavedContent(next);
      if (profileId) setPreview(await mihomoApi.configPreview(profileId));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const snapshot = await mihomoApi.overrideSet(content);
      setSavedContent(snapshot.content);
      setMessage("Local Override 已保存；当前运行内核尚未改变。");
      if (profileId) setPreview(await mihomoApi.configPreview(profileId));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setSaving(false);
    }
  }

  async function apply() {
    if (!profileId) return;
    setApplying(true);
    setError(null);
    setMessage(null);
    try {
      if (content !== savedContent) {
        const snapshot = await mihomoApi.overrideSet(content);
        setSavedContent(snapshot.content);
      }
      const result = await mihomoApi.configApply(profileId);
      setMessage(result.controllerValidated ? "最终配置已通过 Mihomo 校验并加载。" : "最终配置未应用。请先启动 Mihomo 完成 Controller 校验。");
      setPreview(await mihomoApi.configPreview(profileId));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setApplying(false);
    }
  }

  async function previewConfig() {
    if (!profileId) return;
    setLoading(true);
    setError(null);
    try {
      if (content !== savedContent) {
        const snapshot = await mihomoApi.overrideSet(content);
        setSavedContent(snapshot.content);
      }
      setPreview(await mihomoApi.configPreview(profileId));
      setMessage("已生成最终运行配置预览，尚未加载到 Mihomo。");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }

  if (!profileId) {
    return <section className="page-stack"><header className="page-header"><div><p className="eyebrow">OVERRIDE / BUILDER</p><h1>Override</h1><p>维护独立的本地配置覆盖层，应用时和订阅 YAML 合并。</p></div></header><div className="empty-card empty-card-large panel"><Braces size={28} /><strong>还没有可用 Profile</strong><p>先添加并下载订阅，Config Builder 才能生成最终运行配置。</p></div></section>;
  }

  return (
    <section className="page-stack overrides-page">
      <header className="page-header"><div><p className="eyebrow">OVERRIDE / BUILDER</p><h1>Override</h1><p>订阅 YAML 保持只读。本地 Override 独立保存，应用前经过结构校验和 Mihomo Controller 校验。</p></div><div className="override-status"><span className={content === savedContent ? "saved-dot" : "dirty-dot"} />{content === savedContent ? "已保存" : "有未保存修改"}</div></header>
      {error && <div className="error-banner"><ShieldCheck size={17} /><span>{error}</span></div>}
      {message && <div className="success-banner"><Check size={17} /><span>{message}</span></div>}

      <div className="config-flow panel"><span className="flow-step active">1 <b>Subscription Profile</b></span><i>+</i><span className="flow-step active">2 <b>Local Override</b></span><i>→</i><span className="flow-step">3 <b>Config Builder</b></span><i>→</i><span className="flow-step">4 <b>Validate / Reload</b></span></div>

      <div className="override-layout"><section className="override-editor-card panel"><div className="editor-heading"><div><span>LOCAL-OVERRIDE.YAML</span><strong>本地覆盖层</strong></div><FileCode2 size={18} /></div><textarea className="override-editor" value={content} onChange={(event) => setContent(event.target.value)} placeholder={EXAMPLE} spellCheck={false} /><div className="editor-footer"><span>保存路径由 MioProxy 管理，不会写回下载的订阅文件。</span><div><button className="secondary-button" type="button" onClick={() => void save()} disabled={saving || applying}><Save size={16} />{saving ? "保存中…" : "保存 Override"}</button><button className="secondary-button" type="button" onClick={() => void previewConfig()} disabled={loading || saving || applying}><Eye size={16} />预览最终配置</button><button className="primary-button" type="button" onClick={() => void apply()} disabled={applying || saving}><ShieldCheck size={16} />{applying ? "校验并应用…" : "校验并应用"}</button></div></div></section>

        <section className="preview-card panel"><div className="editor-heading"><div><span>GENERATED RUNTIME CONFIG</span><strong>最终配置预览</strong></div><span className={preview?.overrideActive ? "preview-badge active" : "preview-badge"}>{preview?.overrideActive ? "已合并 Override" : "仅订阅"}</span></div>{preview ? <pre className="config-preview">{preview.yaml}</pre> : <div className="preview-empty"><Eye size={22} /><span>点击「预览最终配置」查看合并结果</span></div>}</section></div>
    </section>
  );
}
