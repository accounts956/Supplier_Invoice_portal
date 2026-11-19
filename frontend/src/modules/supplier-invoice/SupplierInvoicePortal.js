import { useState, useRef } from 'react';
import './invoice.css';

const API = process.env.REACT_APP_API_URL || ''; // ⚠️ match your existing API base
const MAX_MB = 10;
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
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const inputRef = useRef(null);

  const pick = (f) => {
    setError('');
    if (!f) return;
    if (!ALLOWED.includes(f.type)) return setError('This file type is not supported. Upload a PDF, JPG or PNG.');
    if (f.size > MAX_MB * 1024 * 1024) return setError(`This file is larger than ${MAX_MB} MB. Upload a smaller file.`);
    setFile(f);
  };

  const clearFile = () => {
    setFile(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file) return setError('Choose an invoice file to send.');
    setError('');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('supplierEmail', email);
      fd.append('invoice', file);
      const res = await fetch(`${API}/api/supplier-invoices`, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || 'The invoice could not be sent. Try again.');
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
          <li>{Icon.check}<span>One invoice per upload, so send each invoice separately</span></li>
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
                <label htmlFor="si-file">Invoice file</label>
                {file ? (
                  <div className="si-file">
                    <div className="si-file-icon">{ext(file)}</div>
                    <div className="si-file-info">
                      <div className="si-file-name">{file.name}</div>
                      <div className="si-file-size">{fmtSize(file.size)}</div>
                    </div>
                    <button type="button" className="si-link" onClick={clearFile}>Remove</button>
                  </div>
                ) : (
                  <label
                    className={`si-drop${over ? ' over' : ''}`}
                    onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                    onDragLeave={() => setOver(false)}
                    onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); }}
                  >
                    {Icon.upload}
                    <strong>Drop your invoice here</strong>
                    <span>or click to browse your files</span>
                    <input
                      id="si-file" ref={inputRef} type="file" accept=".pdf,.jpg,.jpeg,.png"
                      onChange={(e) => pick(e.target.files[0])}
                    />
                  </label>
                )}
              </div>

              <button type="submit" className="si-btn" disabled={busy || !file || !email}>
                {busy && <span className="si-spinner" aria-hidden="true" />}
                {busy ? 'Sending invoice' : 'Send invoice'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}