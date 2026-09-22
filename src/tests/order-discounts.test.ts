import { describe, expect, it } from "vitest";

import {
  calculateDiscountedAmount,
  calculateEffectiveDiscountPercent,
  calculateLineItemTotalPaise,
  calculateOrderTotalAmount,
} from "../application/services/order.service.js";

describe("order discount calculations", () => {
  const baseOrder = {
    discountType: null,
    discountValue: null,
  } as const;

  it("percent-only line discount", () => {
    expect(
      calculateLineItemTotalPaise({
        discountType: "percent",
        discountValue: "10.00",
        quantityMilli: 2000n,
        unitPrice: "100.00",
      }),
    ).toBe(18000n);
  });

  it("flat-only line discount", () => {
    expect(
      calculateLineItemTotalPaise({
        discountType: "flat",
        discountValue: "30.00",
        quantityMilli: 2000n,
        unitPrice: "100.00",
      }),
    ).toBe(17000n);
  });

  it("order-level percent discount", () => {
    expect(
      calculateOrderTotalAmount(
        { discountType: "percent", discountValue: "10.00" },
        [
          {
            discountType: null,
            discountValue: null,
            id: "1",
            orderId: "o1",
            quantityMilli: 2000n,
            sku: "SKU",
            unitPrice: "100.00",
            variantId: "v1",
          },
        ],
      ),
    ).toBe(180);
  });

  it("order-level flat discount", () => {
    expect(
      calculateOrderTotalAmount(
        { discountType: "flat", discountValue: "25.00" },
        [
          {
            discountType: null,
            discountValue: null,
            id: "1",
            orderId: "o1",
            quantityMilli: 2000n,
            sku: "SKU",
            unitPrice: "100.00",
            variantId: "v1",
          },
        ],
      ),
    ).toBe(175);
  });

  it("combined line + order-level discount stacking", () => {
    expect(
      calculateOrderTotalAmount(
        { discountType: "flat", discountValue: "10.00" },
        [
          {
            discountType: "percent",
            discountValue: "10.00",
            id: "1",
            orderId: "o1",
            quantityMilli: 2000n,
            sku: "SKU1",
            unitPrice: "100.00",
            variantId: "v1",
          },
          {
            discountType: "flat",
            discountValue: "5.00",
            id: "2",
            orderId: "o1",
            quantityMilli: 1000n,
            sku: "SKU2",
            unitPrice: "50.00",
            variantId: "v2",
          },
        ],
      ),
    ).toBe(215);
  });

  it("zero-discount regression keeps existing behavior", () => {
    expect(
      calculateOrderTotalAmount(baseOrder, [
        {
          discountType: null,
          discountValue: null,
          id: "1",
          orderId: "o1",
          quantityMilli: 2000n,
          sku: "SKU",
          unitPrice: "100.00",
          variantId: "v1",
        },
      ]),
    ).toBe(200);
  });

  it("clamps discount above total to zero", () => {
    expect(
      calculateOrderTotalAmount(
        { discountType: "flat", discountValue: "999.00" },
        [
          {
            discountType: null,
            discountValue: null,
            id: "1",
            orderId: "o1",
            quantityMilli: 1000n,
            sku: "SKU",
            unitPrice: "50.00",
            variantId: "v1",
          },
        ],
      ),
    ).toBe(0);
  });

  it("flags a 30 percent effective discount over the owner threshold", () => {
    expect(calculateEffectiveDiscountPercent(100, calculateDiscountedAmount({
      amount: 100,
      discountType: "percent",
      discountValue: 30,
    }))).toBeGreaterThan(25);
  });

  it("keeps a 10 percent effective discount below the owner threshold", () => {
    expect(calculateEffectiveDiscountPercent(100, calculateDiscountedAmount({
      amount: 100,
      discountType: "percent",
      discountValue: 10,
    }))).toBeLessThanOrEqual(25);
  });

  it("flags aggregate discount when every line is below threshold but the basket is not", () => {
    const afterLineDiscounts = calculateDiscountedAmount({
      amount: 100,
      discountType: "percent",
      discountValue: 24,
    });
    const finalTotal = calculateDiscountedAmount({
      amount: afterLineDiscounts,
      discountType: "percent",
      discountValue: 2,
    });

    expect(calculateEffectiveDiscountPercent(100, finalTotal)).toBeGreaterThan(25);
  });
});
