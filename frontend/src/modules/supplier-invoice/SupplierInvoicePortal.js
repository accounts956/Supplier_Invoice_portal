import { useState, useRef } from 'react';
import './invoice.css';

const API = process.env.REACT_APP_API_URL || ''; // ⚠️ match your existing API base
const MAX_MB = 10;
const MAX_FILES = 10; // ✅ NEW
const MAX_TOTAL_MB = 15; // ✅ NEW (combined size of all files in one email)
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png'];

const Icon = {
  doc: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" />
    </svg>
  ),
  upload: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
  ),
  alert: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7.5v5M12 16.2v.1" />
    </svg>
  ),
};

const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);
const ext = (f) => (f.type === 'application/pdf' ? 'PDF' : f.type === 'image/png' ? 'PNG' : 'JPG');

export default function SupplierInvoicePortal() {
  const [email, setEmail] = useState('');
  const [files, setFiles] = useState([]); // ✅ NEW (replaces single file)
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const inputRef = useRef(null);

  // ✅ NEW: accepts a FileList / array
  const pick = (list) => {
    setError('');
    const incoming = Array.from(list || []);
    if (!incoming.length) return;
    const next = [...files];
    for (const f of incoming) {
      if (!ALLOWED.includes(f.type)) return setError('This file type is not supported. Upload a PDF, JPG or PNG.');
      if (f.size > MAX_MB * 1024 * 1024) return setError(`"${f.name}" is larger than ${MAX_MB} MB.`);
      if (next.length >= MAX_FILES) return setError(`You can upload up to ${MAX_FILES} files at once.`);
      next.push(f);
    }
    if (next.reduce((sum, x) => sum + x.size, 0) > MAX_TOTAL_MB * 1024 * 1024) // ✅ NEW
      return setError(`Total size of all files must be ${MAX_TOTAL_MB} MB or less.`);
    setFiles(next);
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeFile = (i) => setFiles(files.filter((_, idx) => idx !== i)); // ✅ NEW

  const clearFile = () => {
    setFiles([]); // ✅ CHANGED
    if (inputRef.current) inputRef.current.value = '';
  };


  const submit = async (e) => {
    e.preventDefault();
    if (!files.length) return setError('Choose at least one invoice file to send.'); // ✅ CHANGED
    setError('');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('supplierEmail', email);
      files.forEach((f) => fd.append('invoices', f)); // ✅ CHANGED
      const res = await fetch(`${API}/api/supplier-invoices/multiple`, { method: 'POST', body: fd }); // ✅ CHANGED
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'The invoices could not be sent. Try again.');
      if (data.failed && data.failed.length) { // ✅ NEW: partial success, keep only the failed files
        setFiles(files.filter((f) => data.failed.includes(f.name)));
        throw new Error(data.message);
      }
      setDone(true);
    } catch (err) {
      setError(err.message === 'Failed to fetch' ? 'Cannot reach the server. Check that the backend is running and try again.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setDone(false);
    setEmail('');
    clearFile();
  };

  return (
    <div className="si-shell">
      <aside className="si-aside">
        <div className="si-brand">
          <span className="si-brand-mark" style={{ color: '#fff' }}>{Icon.doc}</span>
          Supplier Invoice Portal
        </div>

        <div>
          <h1>Send your invoice to accounts</h1>
          <p className="lede">Upload your invoice once. It goes straight to the accounts team, with no login needed.</p>
        </div>

        <ul className="si-facts">
          <li>{Icon.doc}<span>Accepts PDF, JPG and PNG files up to {MAX_MB} MB</span></li>
          <li>{Icon.check}<span>Up to 10 invoices per upload</span></li>
          <li>{Icon.upload}<span>Your file is stored privately and used only for payment processing</span></li>
        </ul>
      </aside>

      <main className="si-main">
        <div className="si-sheet">
          {done ? (
            <div className="si-done" role="status">
              <div className="si-check">{Icon.check}</div>
              <h2>Invoice sent</h2>
              <p>Your invoice from {email || 'your account'} has been delivered to the accounts team.</p>
              <button type="button" className="si-btn ghost" onClick={reset}>Send another invoice</button>
            </div>
          ) : (
            <form onSubmit={submit} noValidate={false}>
              <h2>Submit an invoice</h2>
              <p className="sub">Enter your email and attach the invoice.</p>

              {error && (
                <div className="si-alert" role="alert">{Icon.alert}<span>{error}</span></div>
              )}

              <div className="si-field">
                <label htmlFor="si-email">Your email address</label>
                <input
                  id="si-email" className="si-input" type="email" required autoComplete="email"
                  placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)}
                />
              </div>

              <div className="si-field">
                <label htmlFor="si-file">Invoice files</label>
                {/* ✅ NEW: list of selected files */}
                {files.map((f, i) => (
                  <div className="si-file" key={f.name + i} style={{ marginBottom: 8 }}>
                    <div className="si-file-icon">{ext(f)}</div>
                    <div className="si-file-info">
                      <div className="si-file-name">{f.name}</div>
                      <div className="si-file-size">{fmtSize(f.size)}</div>
                    </div>
                    <button type="button" className="si-link" onClick={() => removeFile(i)}>Remove</button>
                  </div>
                ))}
                {files.length < MAX_FILES && (
                  <label
                    className={`si-drop${over ? ' over' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                    onDragLeave={() => setOver(false)}
                    onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files); }}
                  >
                    {Icon.upload}
                    <strong>{files.length ? 'Add more invoices' : 'Drop your invoices here'}</strong>
                    <span>or click to browse your files</span>
                    <input
                      id="si-file" ref={inputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,.png"
                      onChange={(e) => pick(e.target.files)}
                    />
                  </label>
                )}
              </div>

              <button type="submit" className="si-btn" disabled={busy || !files.length || !email}> {/* ✅ CHANGED */}
                {busy && <span className="si-spinner" aria-hidden="true" />}
                {busy ? 'Sending invoices' : files.length > 1 ? `Send ${files.length} invoices` : 'Send invoice'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
