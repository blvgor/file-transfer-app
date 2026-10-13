import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');
type FileInfo = { id: string; filename: string; size: number; url: string; uploadDate?: number };
function formatSize(bytes: number) {
  if (!bytes) return '0 B';
  const index = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** index).toFixed(1)} ${['B', 'KB', 'MB', 'GB', 'TB'][index]}`;
}

function UploadScreen() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const request = useRef<XMLHttpRequest | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState<number | null>(null);
  const [retention, setRetention] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/health`, { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error();
      return response.json();
    }).then(data => { setLimit(data.maxFileSize); setRetention(data.retentionDays); }).catch(() => {});
    return () => { controller.abort(); request.current?.abort(); };
  }, []);

  const upload = useCallback((selected: File) => {
    if (busy.current) return;
    if (limit && selected.size > limit) { setError(`File exceeds the ${formatSize(limit)} limit.`); return; }
    busy.current = true;
    setFile(selected); setUploading(true); setProgress(0); setError('');
    const xhr = new XMLHttpRequest();
    request.current = xhr;
    const fail = (message: string) => { busy.current = false; setUploading(false); setError(message); };
    xhr.upload.onprogress = event => { if (event.lengthComputable) setProgress(event.loaded / event.total * 100); };
    xhr.onload = () => {
      busy.current = false;
      const data = xhr.response;
      if (xhr.status === 200 && data?.id && data?.url && data?.filename) {
        navigate('/result', { state: data });
      } else fail(data?.error || 'Upload failed. Please try again.');
    };
    xhr.onerror = () => fail('The server could not be reached. Please try again.');
    xhr.onabort = () => { busy.current = false; setUploading(false); };
    xhr.open('POST', `${API_BASE}/upload`);
    xhr.responseType = 'json';
    xhr.setRequestHeader('X-Filename', encodeURIComponent(selected.name));
    xhr.send(selected);
  }, [navigate, limit]);
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      const selected = Array.from(event.clipboardData?.items || []).find(item => item.kind === 'file')?.getAsFile();
      if (selected) { event.preventDefault(); upload(selected); }
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [upload]);

  return <section className="panel" aria-labelledby="upload-title">
    <h1 id="upload-title">Transfer File</h1>
    <p className="muted">Drag, drop, or paste a file</p>
    <div className={`drop ${drag ? 'drag' : ''}`} onDragOver={event => { event.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)} onDrop={event => {
        event.preventDefault(); setDrag(false);
        const selected = event.dataTransfer.files[0]; if (selected) upload(selected);
      }}>
      <input ref={input} type="file" hidden aria-label="Select file" disabled={uploading}
        onChange={event => { const selected = event.target.files?.[0]; if (selected) upload(selected); event.target.value = ''; }} />
      <button className="upload-button" aria-label="Choose a file" disabled={uploading} onClick={() => input.current?.click()}>
        <span aria-hidden="true">↑</span>
      </button>
      {uploading ? <div className="progress" role="progressbar" aria-label="Upload progress" aria-valuenow={Math.round(progress)}
        aria-valuemin={0} aria-valuemax={100}><div style={{ width: `${progress}%` }} /></div> : <p>Choose a file</p>}
      {file && <p className="filename">{file.name} · {formatSize(file.size)}{uploading ? ` · ${Math.round(progress)}%` : ''}</p>}
    </div>
    {limit !== null && <p className="small muted">Up to {formatSize(limit)}{retention ? ` · expires after ${retention} days` : ''}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

function ResultScreen() {
  const state = useLocation().state as FileInfo | null;
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const link = useRef<HTMLInputElement>(null);
  const url = state ? window.location.origin + state.url : '';
  useEffect(() => { if (!state) navigate('/', { replace: true }); }, [state, navigate]);
  if (!state) return null;
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setCopied(true); setCopyError(false); }
    catch { link.current?.select(); setCopyError(true); }
  };
  return <section className="panel wide" aria-labelledby="result-title">
    <h1 id="result-title" className="filename">{state.filename}</h1>
    <p className="muted">{formatSize(state.size)} · ready to share</p>
    <div className="link-row">
      <input ref={link} aria-label="Shareable download link" value={url} readOnly onFocus={event => event.target.select()} />
      <button className="button" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
    </div>
    <p className="small muted" role="status">{copyError ? 'Select and copy the link manually.' : 'Anyone with this link can download the file until it expires.'}</p>
    <Link className="button" to={state.url}>Open download page</Link>
    <Link className="text-link" to="/">Transfer another file</Link>
  </section>;
}

function DownloadScreen() {
  const { id, filename } = useParams();
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setInfo(null); setError('');
    fetch(`${API_BASE}/api/file/${id}`, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('File not found or expired.');
      const data: FileInfo = await response.json();
      if (data.filename !== filename) throw new Error('File not found or expired.');
      setInfo(data);
    }).catch(reason => { if (reason.name !== 'AbortError') setError(reason.message); });
    return () => controller.abort();
  }, [id, filename]);
  return <section className="panel" aria-labelledby="download-title">
    <h1 id="download-title">{error ? 'File unavailable' : info ? 'Ready to download' : 'Loading file'}</h1>
    {error ? <p className="error" role="alert">{error}</p> : info ? <>
      <p className="filename">{info.filename}</p><p className="muted">{formatSize(info.size)}</p>
      <a className="button download" href={`${API_BASE}/download/${id}/${encodeURIComponent(info.filename)}`} download={info.filename}>Download file</a>
    </> : <span className="loading" role="status">Loading…</span>}
    <Link className="text-link" to="/">Transfer a file</Link>
  </section>;
}

export default function App() {
  return <main className="app"><Routes>
    <Route path="/" element={<UploadScreen />} /><Route path="/result" element={<ResultScreen />} />
    <Route path="/:id/:filename" element={<DownloadScreen />} />
    <Route path="*" element={<section className="panel"><h1>Page not found</h1><Link className="text-link" to="/">Transfer a file</Link></section>} />
  </Routes></main>;
}
