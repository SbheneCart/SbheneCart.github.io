/* =========================================================
   SbheneCart — Payment Reminder Job
   Runs hourly via GitHub Actions.
   Finds unpaid orders older than 5 hours and sends a reminder.
   ========================================================= */

const admin = require("firebase-admin");
const { Resend } = require("resend");

/* ---------- Firebase init ---------- */
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

/* ---------- Resend init ---------- */
const resend = new Resend(process.env.RESEND_API_KEY);

/* ---------- Config ---------- */
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const FROM_EMAIL = "SbheneCart <info@sbhenecart.co.za>";
const REPLY_TO = "support@sbhenecart.co.za";
const SITE_URL = "https://sbhenecart.co.za";

/* =========================================================
   MAIN
   ========================================================= */
async function main() {
  const now = Date.now();
  const fiveHoursAgo = now - FIVE_HOURS_MS;

  console.log(`[${new Date().toISOString()}] Checking for unpaid orders older than 5 hours…`);
  console.log(`Cutoff timestamp: ${fiveHoursAgo} (${new Date(fiveHoursAgo).toISOString()})`);

  let snapshot;
  try {
    snapshot = await db.collection("orders")
      .where("reminderSent", "==", false)
      .where("timestamp", "<=", fiveHoursAgo)
      .get();
  } catch (err) {
    // Firestore will ask for a composite index on first run — follow the link in the error
    console.error("Firestore query failed:", err.message);
    if (err.message && err.message.includes("index")) {
      console.error("");
      console.error("⚠️  A composite index is required. Click the URL above to create it,");
      console.error("    wait 1–2 minutes, then re-run this workflow.");
    }
    process.exit(1);
  }

  console.log(`Found ${snapshot.size} order(s) matching query.`);

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of snapshot.docs) {
    const order = doc.data();
    const orderId = doc.id;

    // Skip if already paid (status changed since query snapshot)
    const payStatus = (order.payment && order.payment.status) || "";
    if (payStatus === "Paid" || payStatus.includes("Rejected")) {
      skipped++;
      continue;
    }

    // Only remind for unpaid/pending states
    const isUnpaid = payStatus === "Pending Verification"
      || payStatus === "Pending Online"
      || payStatus === "";
    if (!isUnpaid) {
      skipped++;
      continue;
    }

    // Skip if no email — can't reach them
    if (!order.email || !order.email.includes("@")) {
      console.log(`Order ${orderId} has no valid email — marking as handled, no reminder sent.`);
      await doc.ref.update({
        reminderSent: true,
        reminderSkipped: true,
        reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        reminderSkipReason: "no email on file"
      });
      skipped++;
      continue;
    }

    // Send reminder
    try {
      const { data, error } = await resend.emails.send({
        from: FROM_EMAIL,
        reply_to: REPLY_TO,
        to: order.email,
        subject: `Your SbheneCart order #${orderId.substring(0, 8)} is waiting`,
        html: buildReminderEmail(order, orderId)
      });

      if (error) {
        console.error(`Resend failed for ${orderId}:`, error);
        failed++;
        continue;
      }

      await doc.ref.update({
        reminderSent: true,
        reminderSentAt: admin.firestore.FieldValue.serverTimestamp(),
        reminderEmailId: data && data.id ? data.id : null
      });

      console.log(`✅ Reminder sent for order ${orderId} → ${order.email}`);
      sent++;
    } catch (err) {
      console.error(`❌ Exception for order ${orderId}:`, err.message || err);
      failed++;
    }

    // Small delay between emails to be kind to Resend's rate limit
    await sleep(400);
  }

  console.log("");
  console.log(`──── Summary ────`);
  console.log(`Sent:    ${sent}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed:  ${failed}`);
  console.log(`─────────────────`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================================
   EMAIL TEMPLATE
   ========================================================= */
function buildReminderEmail(order, orderId) {
  const customerName = (order.customer && order.customer.name) ? order.customer.name : "there";
  const shortId = orderId.substring(0, 8);
  const total = Number(order.total || 0).toLocaleString('en-ZA');
  const items = (order.items || []).map(i => {
    const variant = [i.selectedColor, i.selectedSize].filter(Boolean).join(" · ");
    return `
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #E2E8F0;">
          <div style="font-weight: 600; color: #0F172A; font-size: 14px;">${escapeHtml(i.name)}</div>
          ${variant ? `<div style="color: #0878D1; font-size: 12px; margin-top: 2px;">${escapeHtml(variant)}</div>` : ""}
          <div style="color: #64748B; font-size: 12px; margin-top: 2px;">Qty: ${i.quantity} · R${Number(i.price).toLocaleString('en-ZA')}</div>
        </td>
        <td style="padding: 10px 0; border-bottom: 1px solid #E2E8F0; text-align: right; color: #0F172A; font-weight: 600; font-size: 14px; vertical-align: top;">
          R${(Number(i.price) * Number(i.quantity)).toLocaleString('en-ZA')}
        </td>
      </tr>
    `;
  }).join("");

  const method = order.payment && order.payment.method ? order.payment.method : "";
  let paymentBlock = "";
  if (method.includes("EFT") || method.includes("Bank")) {
    paymentBlock = `
      <p style="color: #64748B; font-size: 13px; line-height: 1.7; margin: 16px 0 0;">
        <b style="color: #0F172A;">Bank transfer details:</b><br>
        Bank: Capitec Bank<br>
        Account: 2438836438<br>
        Branch Code: 470010<br>
        Reference: <b>${shortId}</b>
      </p>`;
  } else if (method.toLowerCase().includes("cash")) {
    paymentBlock = `
      <p style="color: #64748B; font-size: 13px; line-height: 1.7; margin: 16px 0 0;">
        <b style="color: #0F172A;">Cash Send details:</b><br>
        Send via Capitec Cash Send to: <b>065 358 4906</b><br>
        Reference: <b>${shortId}</b><br>
        Then upload your receipt + PIN from the order page.
      </p>`;
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SbheneCart order reminder</title>
</head>
<body style="margin: 0; padding: 0; background: #F5F7FA; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;">

  <table role="presentation" style="width: 100%; background: #F5F7FA; padding: 30px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" style="max-width: 600px; width: 100%; background: #FFFFFF; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 12px rgba(15,23,42,0.06);">

          <!-- Header -->
          <tr>
            <td style="background: #0878D1; padding: 28px 24px; text-align: center;">
              <div style="color: #FFFFFF; font-size: 22px; font-weight: 800; letter-spacing: -0.4px;">SbheneCart</div>
              <div style="color: rgba(255,255,255,0.85); font-size: 12px; margin-top: 4px;">Shop Smart. Live Better.</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px 28px;">
              <h1 style="margin: 0 0 12px; font-size: 22px; color: #0F172A; font-weight: 800;">Hi ${escapeHtml(customerName)},</h1>
              <p style="color: #64748B; font-size: 14px; line-height: 1.6; margin: 0 0 20px;">
                Your SbheneCart order <b style="color: #0F172A;">#${shortId}</b> is still waiting for payment. We've reserved your items, but they may sell out — complete your order to secure them.
              </p>

              <!-- Items -->
              <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                ${items}
                <tr>
                  <td style="padding: 14px 0 0; font-weight: 800; color: #0F172A; font-size: 15px;">Total</td>
                  <td style="padding: 14px 0 0; text-align: right; font-weight: 800; color: #0878D1; font-size: 18px;">R${total}</td>
                </tr>
              </table>

              <!-- CTA -->
              <table role="presentation" style="width: 100%; margin: 28px 0 24px;">
                <tr>
                  <td align="center">
                    <a href="${SITE_URL}/checkout.html?orderId=${encodeURIComponent(orderId)}&total=${order.total}"
                       style="display: inline-block; background: #0878D1; color: #FFFFFF; padding: 15px 34px; border-radius: 10px; text-decoration: none; font-weight: 700; font-size: 15px;">
                      Complete Your Payment →
                    </a>
                  </td>
                </tr>
              </table>

              ${paymentBlock}

              <p style="color: #64748B; font-size: 13px; line-height: 1.6; margin: 24px 0 0;">
                <b style="color: #0F172A;">Need help?</b> Reply to this email or WhatsApp us at
                <a href="https://wa.me/27653584906" style="color: #0878D1; font-weight: 600;">065 358 4906</a>.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: #F1F5F9; padding: 20px 28px; text-align: center;">
              <div style="color: #64748B; font-size: 11.5px; line-height: 1.6;">
                SbheneCart · <a href="${SITE_URL}" style="color: #0878D1; text-decoration: none;">sbhenecart.co.za</a><br>
                You're receiving this because you started an order on our store.
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

/* =========================================================
   RUN
   ========================================================= */
main()
  .then(() => {
    console.log("Job complete.");
    process.exit(0);
  })
  .catch(err => {
    console.error("Fatal:", err);
    process.exit(1);
  });
