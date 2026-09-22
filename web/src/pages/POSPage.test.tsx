import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { POSPage } from "./POSPage";

const productId = "11111111-1111-4111-8111-111111111111";
const variantId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const cashierId = "44444444-4444-4444-8444-444444444444";
const shiftId = "55555555-5555-4555-8555-555555555555";

const ok = (data: unknown) =>
  Promise.resolve(new Response(JSON.stringify({ data, success: true }), { status: 200 }));

const order = {
  authorization: "Bearer forbidden-terminal-token",
  cashierId,
  cashierName: "Asha",
  createdAt: new Date().toISOString(),
  databaseUrl: "postgres://forbidden",
  discountType: "flat",
  discountValue: 50,
  id: orderId,
  invoiceNumber: "INV/2026-27/000001",
  invoicedAt: "2026-07-29T10:30:00.000Z",
  items: [
    {
      cardNumber: "4111111111111111",
      cvv: "123",
      discountType: null,
      discountValue: null,
      id: "item-1",
      name: "Very Long Product Name That Must Wrap Cleanly At Phone Width",
      orderId,
      quantity: 1,
      sku: "LONG-SKU-1",
      unitPrice: 500,
      variantId,
    },
  ],
  orderStatus: "Paid",
  paymentPreference: "cash",
  shiftId,
  subtotalAmount: 450,
  taxAmount: 50,
  taxRatePercent: 11.11,
  tenders: [
    { amount: "250.00", id: "tender-cash", method: "cash", orderId },
    { amount: "250.00", cardApprovalCode: "APPROVED", cardLast4: "1234", id: "tender-card", method: "card", orderId },
  ],
  terminalId: "terminal-1",
  terminalName: "Counter 1",
  total: 500,
};

const shift = {
  businessDate: "2026-07-29",
  discounts: 0,
  gross: 0,
  orderCount: 0,
  refunds: 0,
  shift: {
    closedAt: null,
    countedCash: null,
    id: shiftId,
    openedAt: new Date().toISOString(),
    openingFloat: "100.00",
    status: "open",
  },
  tax: 0,
  tenders: { card: "0.00", cash: "0.00", UPI: "0.00" },
};

const installHappyFetch = () => {
  const calls: Array<{ body?: unknown; headers?: HeadersInit; method?: string; url: string }> = [];
  let shiftOpen = false;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers, method: init?.method, url });
    if (url.endsWith("/products?limit=100")) {
      return ok([
        {
          brand: "Brand",
          id: productId,
          name: "Very Long Product Name That Must Wrap Cleanly At Phone Width",
          productTypeId: "pt-1",
          styleCode: "STYLE",
        },
      ]);
    }
    if (url.endsWith(`/products/${productId}/variants`)) {
      return ok([
        {
          color: "Black",
          id: variantId,
          productId,
          retailPrice: "500.00",
          size: "M",
          sku: "LONG-SKU-1",
          status: "active",
        },
      ]);
    }
    if (url.endsWith(`/inventory/${variantId}`)) {
      return ok({ availableQtyMilli: "3000", damagedQtyMilli: "0", id: "stock-1", onHandQtyMilli: "3000", reservedQtyMilli: "0", variantId });
    }
    if (url.endsWith("/cashiers")) return ok([{ id: cashierId, name: "Asha" }]);
    if (url.endsWith("/cashiers/verify-pin")) return ok({ cashierId, name: "Asha" });
    if (url.endsWith("/owner/status")) return ok({ authorised: false, expiresAt: null });
    if (url.endsWith("/owner/verify")) return ok({ authorised: true, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
    if (url.endsWith("/owner/end")) return ok({ authorised: false, expiresAt: null });
    if (url.endsWith("/shifts/current")) return ok(shiftOpen ? shift : null);
    if (url.endsWith("/shifts/open")) {
      shiftOpen = true;
      return ok(shift.shift);
    }
    if (url.endsWith("/shifts/close")) return ok({ ...shift, shift: { ...shift.shift, countedCash: "100.00", expectedCash: "100.00", status: "closed", variance: "0.00" } });
    if (url.endsWith("/orders?limit=20")) return ok([order]);
    if (url.endsWith("/orders")) return ok({ ...order, orderStatus: "Draft" });
    if (url.endsWith(`/orders/${orderId}/confirm`)) return ok({ ...order, orderStatus: "Pending" });
    if (url.endsWith(`/orders/${orderId}/pay`)) return ok(order);
    if (url.endsWith(`/orders/${orderId}/email-receipt`)) return ok({ messageId: "msg-1" });
    return ok({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
};

const saveToken = async () => {
  render(<POSPage />);
  await userEvent.type(screen.getByLabelText("Terminal token"), "terminal-secret");
  await userEvent.click(screen.getByRole("button", { name: /save token/i }));
};

describe("POSPage", () => {
  it("shows setup without a token and sends bearer authorization after setup", async () => {
    const calls = installHappyFetch();
    await saveToken();

    await waitFor(() => expect(screen.getByText((_, element) => element?.className === "ax-wordmark")).toBeInTheDocument());
    expect(
      calls.some((call) => call.headers instanceof Headers && call.headers.get("Authorization") === "Bearer terminal-secret"),
    ).toBe(true);
  });

  it("shows blocking 401 screen without clearing the stored token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ message: "Terminal not authorised", success: false }), { status: 401 })),
      ),
    );
    localStorage.setItem("pos_terminal_token", "still-present");
    render(<POSPage />);

    expect(await screen.findByText("Terminal Not Authorised")).toBeInTheDocument();
    expect(localStorage.getItem("pos_terminal_token")).toBe("still-present");
  });

  it("shows the stock figure the server sent, converted out of milli-units", async () => {
    // THE ASSERTION THAT WAS MISSING. GET /inventory/:id returns bigint
    // milli-units serialised as strings — availableQtyMilli: "3000" is three
    // units — and web/src/api/types.ts used to declare `availableQty: number`,
    // a field the server has never sent. POSPage read undefined, and every
    // variant on the counter screen showed a blank stock figure.
    //
    // The suite passed throughout, before the fix and after, because the mocks
    // returned the shape the type declared and NOTHING ASSERTED THE NUMBER.
    // Both sides of that were the same wrong belief. This is the assertion
    // that makes the mock's "3000" mean something.
    installHappyFetch();
    await saveToken();

    await userEvent.click(await screen.findByText("Very Long Product Name That Must Wrap Cleanly At Phone Width"));

    // 3000 milli-units is 3 on the counter screen — not 3000, and not blank.
    expect(await screen.findByText(/stock 3$/)).toBeInTheDocument();
    expect(screen.queryByText(/stock 3000/)).toBeNull();
    expect(screen.queryByText(/stock 0$/)).toBeNull();
  });

  it("completes a sale with discount, split tender, card slip fields, invoice and emailed receipt", async () => {
    const calls = installHappyFetch();
    await saveToken();
    await userEvent.click(await screen.findByRole("button", { name: /open shift/i }));

    await userEvent.click(await screen.findByText("Very Long Product Name That Must Wrap Cleanly At Phone Width"));
    await userEvent.click(await screen.findByText(/Black \/ M/));
    await userEvent.clear(screen.getByLabelText("Order discount value"));
    await userEvent.type(screen.getByLabelText("Order discount value"), "50");
    await userEvent.clear(screen.getByLabelText("Tender amount 1"));
    await userEvent.type(screen.getByLabelText("Tender amount 1"), "250.00");
    await userEvent.click(screen.getByRole("button", { name: /add tender/i }));
    await userEvent.selectOptions(screen.getByLabelText("Tender method 2"), "card");
    await userEvent.clear(screen.getByLabelText("Tender amount 2"));
    await userEvent.type(screen.getByLabelText("Tender amount 2"), "200.00");
    await userEvent.type(screen.getByLabelText("Card slip last-4"), "1234");
    await userEvent.type(screen.getByLabelText("Card slip approval code"), "APPROVED");
    await userEvent.type(screen.getByLabelText("Receipt email"), "buyer@example.com");
    await userEvent.click(screen.getByRole("button", { name: /pay/i }));

    await waitFor(() => expect(screen.getAllByText("INV/2026-27/000001").length).toBeGreaterThan(0));
    expect(calls.some((call) => call.url.endsWith("/email-receipt"))).toBe(true);
    const payCall = calls.find((call) => call.url.endsWith("/pay"));
    expect(JSON.stringify(payCall?.body)).toContain("cardLast4");
    expect(JSON.stringify(payCall?.body)).not.toMatch(/cardNumber|cvv|expiry/i);
  });

  it("signs out cashier without closing shift, clearing token, or blocking sale", async () => {
    const calls = installHappyFetch();
    await saveToken();

    await waitFor(() => expect(screen.getByRole("option", { name: "Asha" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /sign out cashier/i })).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Cashier picker"), cashierId);
    await userEvent.type(screen.getByLabelText("Cashier PIN"), "1234");
    await userEvent.click(screen.getByRole("button", { name: /switch/i }));
    expect(await screen.findByRole("button", { name: /sign out cashier/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /open shift/i }));
    expect(await screen.findByText(/X report/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /sign out cashier/i }));

    expect(screen.getByText("No cashier selected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sign out cashier/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Cashier picker")).toHaveValue("");
    expect(screen.getByLabelText("Cashier PIN")).toHaveValue("");
    expect(screen.getByText(/X report/)).toBeInTheDocument();
    expect(localStorage.getItem("pos_terminal_token")).toBe("terminal-secret");

    await userEvent.click(await screen.findByText("Very Long Product Name That Must Wrap Cleanly At Phone Width"));
    await userEvent.click(await screen.findByText(/Black \/ M/));
    await userEvent.click(screen.getByRole("button", { name: /pay/i }));

    await waitFor(() => expect(screen.getAllByText("INV/2026-27/000001").length).toBeGreaterThan(0));
    const createCall = calls.find((call) => call.url.endsWith("/orders"));
    expect(createCall?.body).not.toHaveProperty("cashierId");
  });

  it("asks for owner override and retries a gated checkout", async () => {
    const calls = installHappyFetch();
    let blockedOnce = false;
    let shiftOpen = false;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers, method: init?.method, url });
      if (url.endsWith("/products?limit=100")) {
        return ok([{ brand: "Brand", id: productId, name: "Very Long Product Name That Must Wrap Cleanly At Phone Width", productTypeId: "pt-1", styleCode: "STYLE" }]);
      }
      if (url.endsWith(`/products/${productId}/variants`)) {
        return ok([{ color: "Black", id: variantId, productId, retailPrice: "500.00", size: "M", sku: "LONG-SKU-1", status: "active" }]);
      }
      if (url.endsWith(`/inventory/${variantId}`)) return ok({ availableQtyMilli: "3000", damagedQtyMilli: "0", id: "stock-1", onHandQtyMilli: "3000", reservedQtyMilli: "0", variantId });
      if (url.endsWith("/cashiers")) return ok([{ id: cashierId, name: "Asha" }]);
      if (url.endsWith("/shifts/current")) return ok(shiftOpen ? shift : null);
      if (url.endsWith("/shifts/open")) {
        shiftOpen = true;
        return ok(shift.shift);
      }
      if (url.endsWith("/orders?limit=20")) return ok([order]);
      if (url.endsWith("/owner/status")) return ok({ authorised: false, expiresAt: null });
      if (url.endsWith("/owner/verify")) return ok({ authorised: true, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() });
      if (url.endsWith("/owner/end")) return ok({ authorised: false, expiresAt: null });
      if (url.endsWith("/orders") && !blockedOnce) {
        blockedOnce = true;
        return Promise.resolve(new Response(JSON.stringify({ errorType: "OWNER_LOGIN_REQUIRED", message: "Owner override required", success: false }), { status: 401 }));
      }
      if (url.endsWith("/orders")) return ok({ ...order, orderStatus: "Draft" });
      if (url.endsWith(`/orders/${orderId}/confirm`)) return ok({ ...order, orderStatus: "Pending" });
      if (url.endsWith(`/orders/${orderId}/pay`)) return ok(order);
      return ok({});
    }));
    await saveToken();
    await userEvent.click(await screen.findByRole("button", { name: /open shift/i }));

    await userEvent.click(await screen.findByText("Very Long Product Name That Must Wrap Cleanly At Phone Width"));
    await userEvent.click(await screen.findByText(/Black \/ M/));
    await userEvent.click(screen.getByRole("button", { name: /pay/i }));

    expect(await screen.findByText("Owner Override")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Owner password"), "correct-owner-password");
    await userEvent.click(screen.getByRole("button", { name: /authorise/i }));

    await waitFor(() => expect(screen.getAllByText("INV/2026-27/000001").length).toBeGreaterThan(0));
    expect(calls.some((call) => call.url.endsWith("/owner/verify"))).toBe(true);
    expect(calls.filter((call) => call.url.endsWith("/orders")).length).toBeGreaterThanOrEqual(2);
  });

  it("does not queue offline sales that need owner override", async () => {
    installHappyFetch();
    await saveToken();
    await userEvent.click(await screen.findByRole("button", { name: /open shift/i }));

    await userEvent.click(await screen.findByText("Very Long Product Name That Must Wrap Cleanly At Phone Width"));
    await userEvent.click(await screen.findByText(/Black \/ M/));
    await userEvent.selectOptions(screen.getByLabelText("Order discount type"), "percent");
    await userEvent.clear(screen.getByLabelText("Order discount value"));
    await userEvent.type(screen.getByLabelText("Order discount value"), "30");
    await userEvent.clear(screen.getByLabelText("Tender amount 1"));
    await userEvent.type(screen.getByLabelText("Tender amount 1"), "350.00");

    fireEvent(window, new Event("offline"));
    await userEvent.click(screen.getByRole("button", { name: /pay/i }));

    expect(await screen.findByText(/Owner override requires connection/i)).toBeInTheDocument();
    expect(screen.queryByText(/Invoice pending until sync/i)).not.toBeInTheDocument();
  });

  it("keeps the connectivity chip steady and queues database-down cash sales", async () => {
    const calls = installHappyFetch();
    await saveToken();
    await userEvent.click(await screen.findByRole("button", { name: /open shift/i }));
    await userEvent.click(await screen.findByText("Very Long Product Name That Must Wrap Cleanly At Phone Width"));
    await userEvent.click(await screen.findByText(/Black \/ M/));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers, method: init?.method, url: String(input) });
        return Promise.resolve(new Response(JSON.stringify({ message: "db unavailable" }), { status: 503 }));
      }),
    );

    await userEvent.click(screen.getByRole("button", { name: /pay/i }));

    expect(await screen.findByText(/Invoice pending until sync/)).toBeInTheDocument();
    expect(await screen.findByText(/Database unavailable: cash sales queue/i)).toBeInTheDocument();
  });

  it("renders a full receipt and excludes forbidden data", async () => {
    installHappyFetch();
    await saveToken();
    await userEvent.click(await screen.findByRole("button", { name: /open shift/i }));

    await userEvent.click(await screen.findByText("Very Long Product Name That Must Wrap Cleanly At Phone Width"));
    await userEvent.click(await screen.findByText(/Black \/ M/));
    await userEvent.click(screen.getByRole("button", { name: /pay/i }));

    const receipt = await screen.findByLabelText("Receipt");
    expect(receipt).toHaveTextContent("AxInventory");
    expect(receipt).toHaveTextContent("TILL RECEIPT");
    expect(receipt).toHaveTextContent("INV/2026-27/000001");
    expect(receipt).toHaveTextContent(orderId.slice(0, 8));
    expect(receipt).toHaveTextContent("Asha");
    expect(receipt).toHaveTextContent("Counter 1");
    expect(receipt).toHaveTextContent("Very Long Product Name That Must Wrap Cleanly At Phone Width");
    expect(receipt).toHaveTextContent("Subtotal");
    expect(receipt).toHaveTextContent("Discount");
    expect(receipt).toHaveTextContent("Tax");
    expect(receipt).toHaveTextContent("Total");
    expect(receipt).toHaveTextContent("Cash");
    expect(receipt).toHaveTextContent("Card");
    expect(receipt).toHaveTextContent("last-4 1234");
    expect(receipt).toHaveTextContent("approval APPROVED");
    expect(receipt.textContent).not.toMatch(/forbidden-terminal-token|postgres:\/\/forbidden|4111111111111111|cvv|123[^4]|Authorization/i);
  });

  it("marks terminal revoked replay entries, preserves them through token change, and exports queue JSON", async () => {
    installHappyFetch();
    await saveToken();
    await userEvent.click(await screen.findByRole("button", { name: /open shift/i }));
    await userEvent.click(await screen.findByText("Very Long Product Name That Must Wrap Cleanly At Phone Width"));
    await userEvent.click(await screen.findByText(/Black \/ M/));
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ message: "Terminal not authorised", success: false }), { status: 401 })),
      ),
    );

    await userEvent.click(screen.getByRole("button", { name: /pay/i }));

    expect(await screen.findByText("Terminal Not Authorised")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Replacement terminal token"));
    await userEvent.type(screen.getByLabelText("Replacement terminal token"), "replacement");
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: [], success: true }), { status: 200 }))));
    await userEvent.click(screen.getByRole("button", { name: /re-enter token/i }));
    expect(localStorage.getItem("pos_terminal_token")).toBe("replacement");
  });

  it("supports cashier verification, offline unverified switch, shifts, and duplicate reprint", async () => {
    const calls = installHappyFetch();
    await saveToken();

    await waitFor(() => expect(screen.getByRole("option", { name: "Asha" })).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Cashier picker"), cashierId);
    await userEvent.type(screen.getByLabelText("Cashier PIN"), "1234");
    await userEvent.click(screen.getByRole("button", { name: /switch/i }));
    await waitFor(() => expect(screen.getAllByText(/Asha/).length).toBeGreaterThan(1));

    await userEvent.click(screen.getByRole("button", { name: /open shift/i }));
    expect(await screen.findByText(/X report/)).toBeInTheDocument();
    expect(screen.queryByText(/Expected/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /close shift/i }));
    expect(calls.some((call) => call.url.endsWith("/shifts/close"))).toBe(false);
    await userEvent.type(screen.getByLabelText("Counted cash"), "100.00");
    await userEvent.click(screen.getByRole("button", { name: /close shift/i }));
    expect(await screen.findByText("Z report")).toBeInTheDocument();
    expect(screen.getByText(/Expected/)).toBeInTheDocument();
    expect(screen.getByText(/Business date 2026-07-29/)).toBeInTheDocument();
    expect(screen.getByText(/Cash ₹0.00 · UPI ₹0.00 · Card ₹0.00/)).toBeInTheDocument();
    expect(screen.getByText("No open shift")).toBeInTheDocument();
    expect(screen.getAllByText(/Asha/).length).toBeGreaterThan(1);
    const closeCall = calls.find((call) => call.url.endsWith("/shifts/close"));
    expect(closeCall?.body).toMatchObject({ cashierId, countedCash: "100.00" });

    await userEvent.click(screen.getByRole("button", { name: /DUPLICATE/i }));
    expect(screen.getByText("DUPLICATE RECEIPT")).toBeInTheDocument();
  });

  it("registers barcode scanner keyboard input when the page has focus", async () => {
    installHappyFetch();
    await saveToken();
    await waitFor(() => expect(screen.getByText("Very Long Product Name That Must Wrap Cleanly At Phone Width")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "L" });
    fireEvent.keyDown(window, { key: "O" });
    fireEvent.keyDown(window, { key: "N" });
    fireEvent.keyDown(window, { key: "G" });
    fireEvent.keyDown(window, { key: "-" });
    fireEvent.keyDown(window, { key: "S" });
    fireEvent.keyDown(window, { key: "K" });
    fireEvent.keyDown(window, { key: "U" });
    fireEvent.keyDown(window, { key: "-" });
    fireEvent.keyDown(window, { key: "1" });
    fireEvent.keyDown(window, { key: "Enter" });

    expect(await screen.findByText(/Scanned LONG-SKU-1/)).toBeInTheDocument();
  });
});
