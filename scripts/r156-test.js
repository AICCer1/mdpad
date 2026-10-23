'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const mainPath = path.join(root, 'src', 'main.js');
let s = fs.readFileSync(mainPath, 'utf8');

const block = `  // 86a. the sidebar carries real information: file age, an empty-state action, and the
  // outline marks the heading the caret sits under
  const sidebar = await (async () => {
    const folder = path.join(dir, 'sidebar-project');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'notes.md'), '# Notes' + String.fromCharCode(10, 10) + 'body');
    fs.writeFileSync(path.join(folder, 'older.md'), '# Older');
    const old = new Date(Date.now() - 3 * 3600 * 1000);
    fs.utimesSync(path.join(folder, 'older.md'), old, old);

    const session = sessions.get(win.webContents.id);
    await session.openFolder(folder);
    await sleep(900);

    const tree = await win.webContents.executeJavaScript(\`(() => ({
      rows: [...document.querySelectorAll('#tree .tree-row')].map((r) => r.textContent.trim()),
      metas: [...document.querySelectorAll('#tree .tree-meta')].map((m) => m.textContent.trim()),
      hasOpenButton: Boolean(document.querySelector('#tree .tree-empty-action button')),
    }))()\`);

    const outline = await win.webContents.executeJavaScript(\`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const nl = String.fromCharCode(10);
      window.__mdpad.setMarkdown(['# One', '', 'alpha', '', '## Two', '', 'beta', '', '## Three', '', 'gamma'].join(nl));
      await sleep(700);
      const items = document.querySelectorAll('#outline-list .outline-item');
      const count = document.querySelector('#outline-count').textContent;
      // Put the caret inside "Two".
      const ed = window.__mdpad.editor;
      let pos = 1;
      ed.state.doc.descendants((node, p) => {
        if (node.isText && node.text === 'beta') pos = p;
      });
      ed.commands.focus(pos);
      await sleep(400);
      const current = window.__mdpad.outlineCurrent();
      // Move to the last section.
      let last = 1;
      ed.state.doc.descendants((node, p) => {
        if (node.isText && node.text === 'gamma') last = p;
      });
      ed.commands.focus(last);
      await sleep(400);
      const currentLast = window.__mdpad.outlineCurrent();
      return { items: items.length, count, current, currentLast };
    })()\`);

    return { tree, outline };
  })();

  step(
    'sidebar-information',
    sidebar.tree.rows.length === 2 &&
      sidebar.tree.metas.length === 2 &&
      sidebar.tree.metas.some((meta) => /h$/.test(meta)) &&
      sidebar.outline.items === 3 &&
      sidebar.outline.count === '3' &&
      sidebar.outline.current === 'Two' &&
      sidebar.outline.currentLast === 'Three',
    sidebar
  );

  // 86b. with no folder, the tree offers an action instead of a sentence
  const treeEmpty = await (async () => {
    const session = sessions.get(win.webContents.id);
    await session.openFolder(null);
    await sleep(600);
    return win.webContents.executeJavaScript(\`(() => ({
      text: document.querySelector('#tree .tree-empty')?.textContent.trim() || '',
      hasButton: Boolean(document.querySelector('#tree .tree-empty-action button')),
    }))()\`);
  })();
  step('tree-empty-action', treeEmpty.hasButton && /Open a folder/.test(treeEmpty.text), treeEmpty);

`;

const marker = '  // 30k. the settings filter narrows the visible fields';
if (s.includes('sidebar-information')) {
  console.log('already present');
  process.exit(0);
}
const at = s.indexOf(marker);
if (at < 0) throw new Error('marker missing');
s = s.slice(0, at) + block + s.slice(at);
fs.writeFileSync(mainPath, s, 'utf8');
console.log('inserted');
