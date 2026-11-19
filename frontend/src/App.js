import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import SupplierInvoicePortal from './modules/supplier-invoice/SupplierInvoicePortal'; // ✅ NEW
import SupplierInvoiceAdmin from './modules/supplier-invoice/SupplierInvoiceAdmin';   // ✅ NEW

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/supplier-invoice" element={<SupplierInvoicePortal />} />
        <Route path="/admin/supplier-invoices" element={<SupplierInvoiceAdmin />} />
        <Route path="*" element={<Navigate to="/supplier-invoice" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
