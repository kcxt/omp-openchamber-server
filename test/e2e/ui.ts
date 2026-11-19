// Thin helpers over OpenChamber's DOM. Selectors live here so a UI refactor touches one file.
import type { Locator, Page } from "playwright-core";

export const composer = (page: Page): Locator => page.locator('[contenteditable="true"]').last();

/** A session row in the sidebar; expands the project first when its sessions are hidden. */
export async function sidebarSession(page: Page, title: string, project = "proj"): Promise<Locator> {
  const row = page.locator(".oc-title-rest", { hasText: title }).first();
  if (!(await row.isVisible().catch(() => false))) {
    await row.waitFor({ state: "visible", timeout: 3_000 }).catch(async () => {
      await page.getByText(project, { exact: true }).first().click();
    });
  }
  await row.waitFor({ state: "visible" });
  return row;
}

export async function openSession(page: Page, title: string, project = "proj"): Promise<void> {
  const row = await sidebarSession(page, title, project);
  await row.click({ force: true });
}

/** Start a draft session in a sidebar project (the "+" on its row). */
export async function newSession(page: Page, project = "proj"): Promise<void> {
  const row = page.locator(".group\\/project", { has: page.getByText(project, { exact: true }) }).first();
  await row.hover();
  await row.locator(`button[aria-label="New session"]`).click({ force: true });
}

export async function send(page: Page, text: string): Promise<void> {
  const box = composer(page);
  await box.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** Pick a model in the composer's model menu. */
export async function pickModel(page: Page, current: string, wanted: string): Promise<void> {
  await page.getByText(current, { exact: true }).last().click();
  await page.getByText(wanted, { exact: true }).last().click();
  await page.keyboard.press("Escape");
}

/** Run an item of the session header menu (the "⋯" next to the title). */
export async function sessionMenu(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Open session actions" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}
