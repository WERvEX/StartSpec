import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import axe from "axe-core";
import { type LaunchedApp, launchApp } from "./launch";

/**
 * The finished-UI check: every main screen, in both languages and both themes, at two window sizes.
 * Each screen must not scroll sideways, cut off text or push text off screen, and must pass axe
 * without serious or critical findings. Screenshots go to test-results/ui/ with an index.html for
 * the review that closes each UI stage.
 */

const SIZES = [
  { width: 1280, height: 800 },
  { width: 1024, height: 700 },
] as const;
const LANGUAGES = ["zh-CN", "en"] as const;
const THEMES = ["light", "dark"] as const;
const OUT = join(import.meta.dirname, "../test-results/ui");

let launched: LaunchedApp;
let page: Page;
const gallery: { variant: string; screen: string; file: string }[] = [];

async function settle() {
  await expect(page.locator(".animate-spin")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(150);
}

async function goTo(hash: string) {
  await page.evaluate((target) => {
    window.location.hash = target;
  }, hash);
  await settle();
}

interface Screen {
  name: string;
  open: () => Promise<void>;
  /** Close a dialog before the next screen. */
  close?: () => Promise<void>;
}

const screens: Screen[] = [
  { name: "workspace", open: () => goTo("#/") },
  {
    name: "questions",
    open: async () => {
      await goTo("#/projects/1");
      await expect(page.getByRole("group").first()).toBeVisible();
    },
  },
  { name: "fast-path", open: () => goTo("#/projects/3") },
  {
    name: "document-prd",
    open: async () => {
      await goTo("#/projects/2");
      await page.getByRole("tab").first().click();
      await settle();
    },
  },
  {
    name: "document-tech",
    open: async () => {
      await page.getByRole("tab").nth(1).click();
      await settle();
    },
  },
  {
    name: "routing",
    open: async () => {
      await page.getByRole("tab").last().click();
      await expect(page.getByRole("table")).toBeVisible();
      await settle();
    },
  },
  {
    // A task opened: why this combination, cheaper ones passed over, the chain, overrides and runs.
    name: "routing-detail",
    open: async () => {
      await page.getByRole("table").getByRole("button").first().click();
      await expect(page.getByRole("combobox", { name: /组合|Combination/ })).toBeVisible();
      await settle();
    },
    close: async () => {
      await page.getByRole("table").getByRole("button").first().click();
    },
  },
  {
    name: "handoff",
    open: async () => {
      await page.getByRole("button", { name: /^(生成交接包|重新生成|Build the package|Build again)$/ }).click();
      await expect(page.getByRole("navigation", { name: /包内文件|Files in the package/ })).toBeVisible();
      await settle();
    },
  },
  ...["models", "agents", "execution", "search", "general", "about"].map(
    (name, index): Screen => ({
      name: `settings-${name}`,
      open: async () => {
        if (index === 0) await goTo("#/settings");
        await page.getByRole("tab").nth(index).click();
        await settle();
      },
    }),
  ),
  {
    // The executor that hands tasks straight to agents, with Claude Desktop's MCP entry; not saved.
    name: "settings-execution-direct",
    open: async () => {
      await page.getByRole("tab").nth(2).click();
      await page.getByRole("radio", { name: /直接交给 Agent|Straight to agents/ }).check();
      await settle();
    },
  },
  {
    name: "folder-browser",
    open: async () => {
      await goTo("#/");
      await page.getByRole("button", { name: /关联本地仓库|Link a local repository/ }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await settle();
    },
    close: async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
    },
  },
  {
    name: "confirm-delete",
    open: async () => {
      await page
        .getByRole("navigation")
        .first()
        .getByRole("button", { name: /^(删除|Delete) / })
        .first()
        .click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await settle();
    },
    close: async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toBeHidden();
    },
  },
];

/** Layout problems a user would see: sideways scrolling, text cut off without an ellipsis, text off screen. */
function layoutProblems(): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const describe = (element: Element) =>
      `<${element.tagName.toLowerCase()}> "${(element.textContent ?? "").trim().slice(0, 40)}"`;
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth + 1) problems.push(`the window scrolls sideways (${root.scrollWidth}px)`);
    for (const pane of document.querySelectorAll("main, aside, [role=dialog]")) {
      const style = getComputedStyle(pane);
      if (style.overflowX !== "hidden" && pane.scrollWidth > pane.clientWidth + 1) {
        problems.push(`${describe(pane).slice(0, 12)} scrolls sideways (${pane.scrollWidth} > ${pane.clientWidth})`);
      }
    }
    const scrollsSideways = (element: Element) => {
      for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
        if (node.matches("main, aside, [role=dialog]")) return false;
        const { overflowX } = getComputedStyle(node);
        if (overflowX === "auto" || overflowX === "scroll") return true;
      }
      return false;
    };
    for (const element of document.querySelectorAll("body *")) {
      const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim());
      if (!ownText) continue;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue; // screen-reader-only text
      const clips = style.overflowX === "hidden" || style.overflowX === "clip";
      if (clips && element.scrollWidth > element.clientWidth + 1 && style.textOverflow !== "ellipsis") {
        problems.push(`${describe(element)} is cut off (${element.scrollWidth} > ${element.clientWidth})`);
      }
      if ((rect.right > window.innerWidth + 1 || rect.left < -1) && !scrollsSideways(element)) {
        problems.push(`${describe(element)} runs off screen (${Math.round(rect.left)}–${Math.round(rect.right)})`);
      }
    }
    // A table fits its box: sideways scrolling would hide its last columns (costs, verdicts) off to the right.
    for (const table of document.querySelectorAll("table")) {
      const box = table.parentElement;
      if (box && box.scrollWidth > box.clientWidth + 1) {
        problems.push(`a table needs sideways scrolling (${box.scrollWidth} > ${box.clientWidth})`);
      }
    }
    // A box that scrolls by a few pixels shows a stray scrollbar; that is a rendering slip, not content.
    for (const element of document.querySelectorAll("body *")) {
      const { overflowX, overflowY } = getComputedStyle(element);
      const scrolls = (value: string) => value === "auto" || value === "scroll";
      const extraY = element.scrollHeight - element.clientHeight;
      const extraX = element.scrollWidth - element.clientWidth;
      if ((scrolls(overflowY) && extraY > 0 && extraY <= 4) || (scrolls(overflowX) && extraX > 0 && extraX <= 4)) {
        problems.push(`${describe(element)} scrolls by ${Math.max(extraX, extraY)}px`);
      }
    }
    // A button or tab label should stay on one line; wrapping means the control is too narrow for it.
    // Long task titles inside table cells may wrap.
    for (const control of document.querySelectorAll("button, [role=tab], a[class*='inline-flex']")) {
      if (control.closest("td") || control.getBoundingClientRect().width <= 1) continue;
      const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || !node.parentElement) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        const style = getComputedStyle(node.parentElement);
        const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4;
        if (rect.height > lineHeight * 1.6) {
          problems.push(`${describe(control)} wraps onto ${Math.round(rect.height / lineHeight)} lines`);
          break;
        }
      }
    }
    return problems;
  });
}

/** axe-core runs inside the window; its Playwright wrapper needs a second page, which Electron does not offer. */
async function seriousAxeFindings(): Promise<string[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.evaluate(axe.source);
  return page.evaluate(async () => {
    const runner = (window as unknown as { axe: typeof axe }).axe;
    const result = await runner.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
      resultTypes: ["violations"],
    });
    return result.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map(
        (violation) =>
          `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes
            .slice(0, 3)
            .map((node) => node.target.join(" "))
            .join(", ")}`,
      );
  });
}

test.beforeAll(async () => {
  launched = await launchApp({ KM0_FAKE_LLM: "1" });
  page = launched.page;
  // Project 1 waits on its first questions, project 2 has documents and routed tasks, project 3 took the fast path.
  const start = async (description: string) => {
    await page.getByRole("link", { name: /新建任务/ }).click();
    await page.getByRole("textbox", { name: "从一句话开始" }).fill(description);
    await page.getByRole("button", { name: "开始分诊" }).click();
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("从一句话开始");
  };
  await start("从零做一个团队需求管理平台");
  await expect(page.getByText("A 定位与规模 · 第 1 轮")).toBeVisible();
  await start("从零做一个内部知识库平台");
  for (const stage of ["A 定位与规模", "B 产品需求", "C 技术选型", "D 实现方案"]) {
    await expect(page.getByText(`${stage} · 第 1 轮`)).toBeVisible();
    await page.getByRole("button", { name: "跳过剩余问题，进入下一阶段" }).click();
  }
  await expect(page.getByRole("heading", { name: "8. 待定问题" })).toBeVisible();
  await page.getByRole("tab", { name: "任务与路由" }).click();
  await page.getByRole("button", { name: "拆解任务并路由" }).click();
  await expect(page.getByRole("table")).toBeVisible();
  await start("修复登录页按钮的拼写错误");
  mkdirSync(OUT, { recursive: true });
});

test.afterAll(async () => {
  const rows = gallery
    .map(
      ({ variant, screen, file }) =>
        `<figure><img src="${file}" loading="lazy"><figcaption>${variant} · ${screen}</figcaption></figure>`,
    )
    .join("\n");
  writeFileSync(
    join(OUT, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>KM0 UI review</title><style>body{font:14px system-ui;margin:24px;background:#eee}figure{display:inline-block;margin:0 16px 24px 0;vertical-align:top}img{width:420px;border:1px solid #ccc;background:#fff}figcaption{margin-top:4px}</style>\n${rows}\n`,
  );
  await launched?.close();
});

for (const language of LANGUAGES) {
  for (const theme of THEMES) {
    test(`every screen is laid out and accessible in ${language}, ${theme}`, async () => {
      test.setTimeout(240_000);
      await page.evaluate((preferences) => window.km0.invoke("settings.preferences.set", preferences), {
        language,
        theme,
      } as const);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await expect(page.locator("html")).toHaveClass(theme === "dark" ? /dark/ : /^(?!.*dark)/);

      const problems: string[] = [];
      for (const size of SIZES) {
        await page.setViewportSize(size);
        const variant = `${language}-${theme}-${size.width}x${size.height}`;
        mkdirSync(join(OUT, variant), { recursive: true });
        for (const [index, screen] of screens.entries()) {
          await screen.open();
          const file = `${variant}/${String(index + 1).padStart(2, "0")}-${screen.name}.png`;
          await page.screenshot({ path: join(OUT, file) });
          gallery.push({ variant, screen: screen.name, file });
          for (const problem of await layoutProblems()) problems.push(`${variant} ${screen.name}: ${problem}`);
          // Contrast and structure do not depend on the window size; check them once per theme and language.
          if (size === SIZES[0]) {
            for (const finding of await seriousAxeFindings()) problems.push(`${variant} ${screen.name}: ${finding}`);
          }
          await screen.close?.();
        }
      }
      expect(problems, "UI problems").toEqual([]);
    });
  }
}

test("dialogs can be used with the keyboard alone", async () => {
  await page.evaluate(() => window.km0.invoke("settings.preferences.set", { language: "zh-CN", theme: "light" }));
  await page.reload();
  await page.setViewportSize(SIZES[0]);
  await goTo("#/");
  const link = page.getByRole("button", { name: "关联本地仓库（可选）" });
  await link.focus();
  await page.keyboard.press("Enter");
  const browser = page.getByRole("dialog", { name: "选择本地仓库" });
  await expect(browser).toBeVisible();
  // Focus moves into the dialog and stays there.
  const focusInside = () => browser.evaluate((dialog) => dialog.contains(document.activeElement));
  expect(await focusInside()).toBe(true);
  for (let i = 0; i < 12; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInside()).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(browser).toBeHidden();
  // Closing returns focus to the button that opened it.
  await expect(link).toBeFocused();
});
