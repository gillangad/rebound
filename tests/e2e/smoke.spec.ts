import { expect, test } from "@playwright/test";

test("merchant batch review, Atelier approval, secure customer page and history are usable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Review these cases" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Atelier Works Pvt Ltd" })).toBeVisible();
  await expect(page.getByText("Investigate next")).toBeVisible();
  await expect(page.getByText("Approval required")).toHaveCount(0);
  await expect(page.getByText("Try Demo · isolated workspace")).toBeVisible();
  await expect(page.getByRole("button", { name: /Try Demo/ })).toBeVisible();
  await page.getByRole("tab", { name: "Messages & documents" }).click();
  await expect(page.getByText("No messages yet")).toBeVisible();
  await page.getByRole("tab", { name: "Overview" }).click();

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();

  await page.locator("#agent-instruction").fill("Review these cases independently, resolve what you can, and bring me anything that needs approval.");
  await page.getByRole("button", { name: "Send instruction" }).click();
  await expect(page.getByText("Approval required").first()).toBeVisible();
  await expect(page.getByLabel("Evidence path")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Rebound agent" })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("tab", { name: "Messages & documents" }).click();
  await expect(page.getByText("NW-DELIVERY-ATELIER-30-DESKS.txt")).toBeVisible();
  await expect(page.getByText(/fixture · Customer Atelier Works Pvt Ltd.*readable delivery content match/)).toBeVisible();
  await page.getByRole("tab", { name: "Overview" }).click();

  await page.getByRole("button", { name: "Approve & send" }).first().click();
  await expect(page.getByText("Customer payment page")).toBeVisible();
  const customerLink = page.getByRole("link", { name: "Open customer page" });
  await expect(customerLink).toBeVisible();
  const customerPagePromise = page.waitForEvent("popup");
  await customerLink.click();
  const customerPage = await customerPagePromise;
  await customerPage.waitForLoadState("networkidle");
  await expect(customerPage.getByText("Pay securely with Razorpay")).toBeVisible();
  await expect(customerPage.getByText("NW-DELIVERY-ATELIER-30-DESKS.txt")).toBeVisible();
  await customerPage.getByRole("button", { name: "Pay securely with Razorpay" }).click();
  await expect(customerPage.getByRole("heading", { name: "Payment verified" })).toBeVisible();

  await page.goto("/incidents");
  await expect(page.getByRole("heading", { name: "Shared incidents" })).toBeVisible();
  await expect(page.getByText("Demo simulation").first()).toBeVisible();
  await page.goto("/connections");
  await expect(page.getByRole("heading", { name: "Connections" }).first()).toBeVisible();
  await expect(page.getByText("Fixture evidence").first()).toBeVisible();
  await page.goto("/history");
  await expect(page.getByRole("heading", { name: "History" }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Evaluation results" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Evaluation results" }).locator("strong").filter({ hasText: /^30$/ })).toBeVisible();
  await page.goto("/policies");
  await expect(page.getByRole("heading", { name: "Policies" }).first()).toBeVisible();

  await page.goto("/");
  await page.getByRole("button", { name: /Open Rebound agent activity/ }).click();
  await expect(page.getByRole("dialog", { name: "Rebound agent" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Rebound agent" })).toHaveCount(0);
});
