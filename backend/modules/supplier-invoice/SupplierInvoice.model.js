const mongoose = require('mongoose');

const SupplierInvoiceSchema = new mongoose.Schema({
  supplierEmail: { type: String, required: true, lowercase: true, trim: true },
  originalName:  { type: String, required: true },
  storedName:    { type: String, required: true },
  mimeType:      { type: String, required: true },
  size:          { type: Number, required: true },
  status:        { type: String, enum: ['pending', 'sent', 'failed'], default: 'pending' },
  attempts:      { type: Number, default: 0 },
  lastError:     { type: String, default: '' },
  sentAt:        { type: Date },
  messageId:     { type: String },
}, { timestamps: true });

module.exports = mongoose.model('SupplierInvoice', SupplierInvoiceSchema);
