// Exercise the real visible popover rather than dispatching synthetic setting
// events into controls that a modal might otherwise make inert.
export async function openAppearanceMenu(page, kind) {
  if (!["language", "theme"].includes(kind)) throw new Error(`Unknown appearance menu: ${kind}`);
  const menu = page.locator(`#${kind}-menu`);
  if (!(await menu.isVisible())) await page.locator(`#${kind}-menu-button`).click();
  await menu.waitFor({ state: "visible" });
  return menu;
}

export async function chooseAppearance(page, kind, value) {
  await openAppearanceMenu(page, kind);
  await page.locator(`#${kind}-control label:has(input[value="${value}"])`).click();
  await page.locator(`#${kind}-menu`).waitFor({ state: "hidden" });
}
