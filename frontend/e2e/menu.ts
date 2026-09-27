import type { Page } from '@playwright/test'

/**
 * Run a menu command the way a person does: click the title, then each item
 * along the path ('File', 'Export', 'OpenDSS (.dss)'). Items are found by
 * their accessible name, which leaves out the shortcut hint and check mark.
 */
export async function menu(page: Page, title: string, ...path: string[]) {
  await page.getByRole('menubar').getByRole('button', { name: title, exact: true }).click()
  for (const label of path) {
    await page
      .getByRole('menu')
      .last()
      .locator(`[role^="menuitem"][aria-label="${label}"]`)
      .click()
  }
}

/** A menu item's element, for asserting on its state without running it. */
export async function menuItem(page: Page, title: string, ...path: string[]) {
  await page.getByRole('menubar').getByRole('button', { name: title, exact: true }).click()
  const last = path.pop()!
  for (const label of path) {
    await page.getByRole('menu').last().locator(`[role^="menuitem"][aria-label="${label}"]`).click()
  }
  return page.getByRole('menu').last().locator(`[role^="menuitem"][aria-label="${last}"]`)
}
