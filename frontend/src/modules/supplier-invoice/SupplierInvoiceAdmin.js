import { useEffect, useState, useCallback } from 'react';
import './invoice.css';

const API = process.env.REACT_APP_API_URL || '';
const auth = () => ({ Authorization: `Bearer ${localStorage.getItem('token')}` }); // ⚠️ match your token key

export default function SupplierInvoiceAdmin() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [retrying, setRetrying] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`${API}/api/supplier-invoices/admin/list`, { headers: auth() });
      if (res.status === 401 || res.status === 403) { setLocked(true); return; }
      if (!res.ok) throw new Error('Could not load invoices.');
      setLocked(false);
      setRows(await res.json());
    } catch (e) {
      setError(e.message === 'Failed to fetch' ? 'Cannot reach the server. Check that the backend is running.' : e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const retry = async (id) => {
    setRetrying(id);
    await fetch(`${API}/api/supplier-invoices/admin/${id}/retry`, { method: 'POST', headers: auth() });
    setRetrying('');
    load();
  };

  const saveToken = (e) => {
    e.preventDefault();
    localStorage.setItem('token', tokenInput.trim());
    setTokenInput('');
    load();
  };

  if (locked) {
    return (
      <form className="ad-login" onSubmit={saveToken}>
        <h1>Admin access</h1>
        <p>Enter the admin token from your backend .env file.</p>
        <input className="si-input" type="password" required placeholder="ADMIN_TOKEN" value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} />
        <button className="si-btn" type="submit">Unlock invoices</button>
      </form>
    );
  }

  const count = (s) => rows.filter((r) => r.status === s).length;

  return (
    <div className="ad-wrap">
      <div className="ad-top">
        <div>
          <h1>Supplier invoices</h1>
          <p>Invoices submitted through the portal and their email status.</p>
        </div>
        <button className="ad-btn" onClick={load} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </div>

      {error && <div className="si-alert" role="alert"><span>{error}</span></div>}

      <div className="ad-stats">
        <div className="ad-stat"><b>{rows.length}</b><span>Total received</span></div>
        <div className="ad-stat ok"><b>{count('sent')}</b><span>Emailed to accounts</span></div>
        <div className="ad-stat bad"><b>{count('failed')}</b><span>Need a retry</span></div>
      </div>

      <div className="ad-table-wrap">
        {rows.length === 0 ? (
          <div className="ad-empty">{loading ? 'Loading invoices…' : 'No invoices yet. New uploads will appear here.'}</div>
        ) : (
          <table className="ad-table">
            <thead>
              <tr><th>Received</th><th>Supplier email</th><th>File</th><th>Status</th><th>Details</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._id}>
                  <td>{new Date(r.createdAt).toLocaleString()}</td>
                  <td>{r.supplierEmail}</td>
                  <td>{r.originalName}</td>
                  <td><span className={`ad-pill ${r.status}`}>{r.status}</span></td>
                  <td className="ad-err">{r.lastError}</td>
                  <td>
                    {r.status === 'failed' && (
                      <button className="ad-btn small primary" onClick={() => retry(r._id)} disabled={retrying === r._id}>
                        {retrying === r._id ? 'Sending…' : 'Retry'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}