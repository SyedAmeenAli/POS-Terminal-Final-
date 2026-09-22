/**
 * Restore verification.
 *
 * Confirms a Cloud SQL backup actually restored usable data. "Backups enabled"
 * and "backups restorable" are different claims; this checks the second.
 *
 * Read-only. Never point it at production expecting it to change anything, and
 * never restore over production to run it.
 *
 * Usage:
 *   1. Restore a backup to a NEW instance in the Console (never in place).
 *   2. Run a second Auth Proxy against the clone on a spare port:
 *        cloud-sql-proxy --address 127.0.0.1 --port 15433 \
 *          ims-project-503105:asia-south2:<clone-instance>
 *   3. VERIFY_DATABASE_URL='postgresql://postgres:<pw>@127.0.0.1:15433/final_ims_build' \
 *        pnpm verify:restore
 *   4. Compare the output against the production baseline recorded in
 *      docs/implementation-status.md.
 *   5. Delete the clone — it bills hourly.
 */
import { Pool } from "pg";

const connectionString = process.env.VERIFY_DATABASE_URL;

if (!connectionString) {
  console.error(
    "VERIFY_DATABASE_URL is required. Point it at the RESTORED CLONE, not production.",
  );
  process.exit(1);
}

const isLocalProxy =
  connectionString.includes("127.0.0.1") || connectionString.includes("localhost");

const pool = new Pool({
  connectionString,
  max: 2,
  ssl: isLocalProxy ? undefined : { rejectUnauthorized: false },
});

const main = async (): Promise<void> => {
  const one = async (sql: string): Promise<Record<string, unknown>> => {
    const result = await pool.query(sql);
    return result.rows[0] ?? {};
  };

  const orders = await one(
    "select count(*)::int as n, max(created_at) as latest from sales_orders",
  );
  const items = await one("select count(*)::int as n from sales_order_items");
  const tenders = await one("select count(*)::int as n from payment_tenders");
  const invoices = await one(
    "select count(*)::int as n, max(invoice_number) as max_invoice from sales_orders where invoice_number is not null",
  );
  const shifts = await one("select count(*)::int as n from pos_shifts");

  // Gapless invoice numbering is a legal requirement, so verify it survived the
  // restore rather than assuming a row count implies correctness.
  const gaps = await one(`
    select count(*)::int as n
    from (
      select invoice_number,
             row_number() over (order by invoice_number) as expected,
             split_part(invoice_number, '/', 3)::int as actual
      from sales_orders
      where invoice_number is not null
    ) numbered
    where expected <> actual
  `);

  console.log(
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        target: connectionString.replace(/:[^:@]*@/, ":[REDACTED]@"),
        sales_orders: orders.n,
        latest_order: orders.latest,
        sales_order_items: items.n,
        payment_tenders: tenders.n,
        invoiced_orders: invoices.n,
        max_invoice_number: invoices.max_invoice,
        pos_shifts: shifts.n,
        invoice_sequence_gaps: gaps.n,
      },
      null,
      2,
    ),
  );

  if (Number(gaps.n) > 0) {
    console.error(
      `\nWARNING: ${String(gaps.n)} invoice-number gaps found in the restored data.`,
    );
  }

  await pool.end();
};

void main().catch((error: unknown) => {
  console.error("Restore verification failed.", error);
  process.exit(1);
});
