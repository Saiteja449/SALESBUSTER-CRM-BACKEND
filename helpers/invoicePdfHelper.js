/**
 * Zero-dependency PDF 1.4 Tax Invoice Generator
 * Produces a valid, standard-compliant PDF buffer with Helvetica & Helvetica-Bold fonts.
 */

const escapePdfText = (str) =>
  String(str ?? "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");

const formatInrAscii = (amount) => {
  const num = Number(amount || 0);
  return `INR ${num.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

export const generateInvoicePdfBuffer = ({ order = {}, organization = {} }) => {
  const orderId = order.orderId || `ORD_${Date.now()}`;
  const invoiceNumber = `INV-${orderId}`;
  const customerName =
    order.customerDetails?.customerName || organization?.name || "Valued Customer";
  const customerEmail =
    order.customerDetails?.customerEmail || organization?.email || "-";
  const customerPhone =
    order.customerDetails?.customerPhone || organization?.mobile || "-";
  const orgName = organization?.name || customerName;

  const paymentDate = order.paymentDetails?.paymentTime
    ? new Date(order.paymentDetails.paymentTime).toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      })
    : new Date().toLocaleDateString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Kolkata",
      });

  const paymentRef =
    order.paymentDetails?.cfPaymentId ||
    order.paymentDetails?.bankReference ||
    order.cfOrderId ||
    "Cashfree PG";
  const paymentMethod = String(
    order.paymentDetails?.paymentMethod || "Online"
  ).toUpperCase();

  const planTitle =
    order.notes ||
    (order.planId === "yearly"
      ? "Yearly Plan (5 Sales Rep Seats)"
      : order.planId === "quarterly"
      ? "Quarterly Plan (5 Sales Rep Seats)"
      : order.purpose === "extra_reps"
      ? `Additional Sales Reps (${order.additionalReps || 1} Seats)`
      : order.purpose === "addon"
      ? `Feature Add-on: ${order.addonType || "Module"}`
      : `${order.planId || "Subscription"} Plan`);

  const gstRateRaw = typeof order.gstRate === "number" ? order.gstRate : 0.18;
  const gstPercent =
    gstRateRaw <= 1 && gstRateRaw > 0
      ? Math.round(gstRateRaw * 10000) / 100
      : gstRateRaw;

  const totalAmount = Number(order.orderAmount || 0);
  const baseAmount =
    typeof order.baseAmount === "number" && order.baseAmount > 0
      ? order.baseAmount
      : Math.round((totalAmount / (1 + gstPercent / 100)) * 100) / 100;
  const gstAmount =
    typeof order.gstAmount === "number" && order.gstAmount >= 0
      ? order.gstAmount
      : Math.round((totalAmount - baseAmount) * 100) / 100;

  const ops = [];
  const textLine = (x, y, text, size = 10, bold = false) => {
    const font = bold ? "/F2" : "/F1";
    ops.push(`BT ${font} ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`);
  };
  const hLine = (x1, y, x2) => {
    ops.push(`0.8 w 0.85 0.87 0.90 RG ${x1} ${y} m ${x2} ${y} l S`);
  };

  // Header band
  ops.push("0.05 0.58 0.53 rg 40 730 515 70 re f");
  ops.push("1 1 1 rg");
  ops.push(`BT /F2 20 Tf 56 772 Td (${escapePdfText("SALESBUSTER AI CRM")}) Tj ET`);
  ops.push(`BT /F1 10 Tf 56 752 Td (${escapePdfText("Official Tax Invoice & Payment Receipt | info@salesbuster.ai")}) Tj ET`);
  ops.push(`BT /F2 14 Tf 430 765 Td (${escapePdfText("TAX INVOICE")}) Tj ET`);

  // Reset text fill to dark slate
  ops.push("0.08 0.11 0.16 rg");

  // Invoice Metadata
  textLine(45, 700, "Invoice Number:", 10, true);
  textLine(145, 700, invoiceNumber, 10, false);
  textLine(45, 684, "Order ID:", 10, true);
  textLine(145, 684, orderId, 10, false);
  textLine(45, 668, "Invoice Date:", 10, true);
  textLine(145, 668, paymentDate, 10, false);

  textLine(340, 700, "Payment Status:", 10, true);
  textLine(435, 700, String(order.orderStatus || "PAID").toUpperCase(), 10, true);
  textLine(340, 684, "Payment Ref:", 10, true);
  textLine(435, 684, paymentRef, 10, false);
  textLine(340, 668, "Method:", 10, true);
  textLine(435, 668, paymentMethod, 10, false);

  hLine(45, 650, 550);

  // Billed To
  textLine(45, 628, "BILLED TO", 10, true);
  textLine(45, 610, customerName, 11, true);
  textLine(45, 594, `Organization: ${orgName}`, 10, false);
  textLine(45, 578, `Email: ${customerEmail}`, 10, false);
  textLine(45, 562, `Phone: ${customerPhone}`, 10, false);

  hLine(45, 542, 550);

  // Table Header
  ops.push("0.95 0.96 0.98 rg 45 512 505 24 re f");
  ops.push("0.08 0.11 0.16 rg");
  textLine(55, 520, "Description", 10, true);
  textLine(440, 520, "Amount", 10, true);

  // Line Item 1
  const truncatedTitle = planTitle.length > 62 ? `${planTitle.slice(0, 59)}...` : planTitle;
  textLine(55, 488, truncatedTitle, 10, false);
  textLine(440, 488, formatInrAscii(baseAmount), 10, false);

  if (order.additionalReps && order.purpose !== "extra_reps") {
    textLine(55, 470, `Licensed Seats: ${5 + Number(order.additionalReps)} Sales Representatives`, 9, false);
  }

  hLine(45, 450, 550);

  // Totals
  textLine(330, 428, "Subtotal (Base):", 10, false);
  textLine(440, 428, formatInrAscii(baseAmount), 10, false);

  textLine(330, 410, `GST (${gstPercent}%):`, 10, false);
  textLine(440, 410, formatInrAscii(gstAmount), 10, false);

  hLine(325, 396, 550);

  textLine(330, 376, "Total Paid:", 12, true);
  textLine(440, 376, formatInrAscii(totalAmount), 12, true);

  // Footer
  hLine(45, 110, 550);
  textLine(45, 90, "Thank you for choosing SalesBuster AI CRM.", 10, true);
  textLine(45, 74, "This is a computer-generated GST Tax Invoice and requires no physical signature.", 9, false);

  const streamContent = ops.join("\n");
  const streamLength = Buffer.byteLength(streamContent, "utf8");

  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\nendobj\n",
    `6 0 obj\n<< /Length ${streamLength} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += obj;
  }

  const xrefOffset = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "utf8");
};

export default { generateInvoicePdfBuffer };
