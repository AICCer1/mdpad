'use strict';

// Tiny dictionary shared by the main process (menus, dialogs) and the renderer
// (labels). Keys are flat and namespaced by surface.

const DICT = {
  en: {
    'menu.file': 'File',
    'menu.edit': 'Edit',
    'menu.go': 'Go',
    'menu.view': 'View',
    'menu.help': 'Help',
    'menu.new': 'New',
    'menu.newWindow': 'New Window',
    'menu.open': 'Open…',
    'menu.openRecent': 'Open Recent',
    'menu.clearRecent': 'Clear Recent',
    'menu.openFolder': 'Open Folder…',
    'menu.save': 'Save',
    'menu.saveAs': 'Save As…',
    'menu.exportHtml': 'Export HTML…',
    'menu.exportPdf': 'Export PDF…',
    'menu.exportWord': 'Export Word…',
    'menu.exportEpub': 'Export EPUB…',
    'menu.backups': 'Show Backups Folder',
    'menu.logs': 'Show Logs Folder',
    'menu.quit': 'Quit',
    'menu.close': 'Close',
    'menu.find': 'Find…',
    'menu.outline': 'Toggle Outline',
    'menu.about': 'About mdpad',
    'menu.checkUpdates': 'Check for Updates…',
    'menu.empty': '(empty)',

    'dialog.unsavedTitle': 'Unsaved changes',
    'dialog.unsavedMessage': '{count} document(s) with unsaved changes',
    'dialog.unsavedDetail': 'Closing keeps them as recovery drafts; reopening the file will offer to restore them.',
    'dialog.keepEditing': 'Keep editing',
    'dialog.closeKeepDrafts': 'Close and keep drafts',
    'dialog.saveFailedTitle': 'Save failed',
    'dialog.saveFailedMessage': 'Could not save the document',
    'dialog.retry': 'Retry',
    'dialog.saveAs': 'Save As…',
    'dialog.cancel': 'Cancel',
    'dialog.ok': 'OK',
    'dialog.updateTitle': 'mdpad updates',
    'dialog.updateAvailable': 'A new version is available',
    'dialog.upToDate': 'You are up to date',
    'dialog.updateFailed': 'Update check failed',
    'dialog.aboutDetail': 'Electron {electron}\nChromium {chromium}\nNode {node}\n\nData: {data}',

    'ui.find': 'Find',
    'ui.open': 'Open',
    'ui.save': 'Save',
    'ui.exportHtml': 'HTML',
    'ui.exportPdf': 'PDF',
    'ui.settings': 'Settings',
    'ui.theme': 'Theme',
    'ui.themeLight': 'Light',
    'ui.themeDark': 'Dark',
    'ui.themeSepia': 'Sepia',

    'empty.title': 'mdpad',
    'empty.subtitle': 'A markdown editor that survives crashes and interruptions',
    'empty.new': 'New document',
    'empty.folder': 'Open a folder',
    'empty.ai': 'Try AI writing',
    'empty.tip': 'Ctrl+Shift+P for commands · F1 for shortcuts',

    'settings.title': 'Settings',
    'settings.theme': 'Theme',
    'settings.autosave': 'Autosave (seconds)',
    'settings.language': 'Language',
    'settings.aiSection': 'AI writing',
    'settings.endpoint': 'Endpoint',
    'settings.model': 'Model',
    'settings.apiKey': 'API key',
    'settings.keySaved': 'A key is saved in the OS credential store.',
    'settings.keyWeak': 'A key is saved, but only obfuscated — the OS credential store was unavailable.',
    'settings.noKey': 'No key saved yet.',
    'settings.save': 'Save',
    'settings.cancel': 'Cancel',
    'settings.saved': 'saved',

    'ai.run': 'Run',
    'ai.retry': 'Retry',
    'ai.stop': 'Stop',
    'ai.insert': 'Insert',
    'ai.replace': 'Replace selection',
    'ai.preview': 'Preview changes',
    'ai.clear': 'Clear context',
    'ai.instruction': 'Instruction — continue, tighten, translate, turn into a table…',
    'ai.resultPlaceholder': 'Result streams in here before you insert it',

    'stats.title': 'Document statistics',
    'stats.close': 'Close',
    'palette.placeholder': 'Type a command…',
  },

  zh: {
    'menu.file': '文件',
    'menu.edit': '编辑',
    'menu.go': '转到',
    'menu.view': '视图',
    'menu.help': '帮助',
    'menu.new': '新建',
    'menu.newWindow': '新建窗口',
    'menu.open': '打开…',
    'menu.openRecent': '最近打开',
    'menu.clearRecent': '清空最近记录',
    'menu.openFolder': '打开文件夹…',
    'menu.save': '保存',
    'menu.saveAs': '另存为…',
    'menu.exportHtml': '导出 HTML…',
    'menu.exportPdf': '导出 PDF…',
    'menu.exportWord': '导出 Word…',
    'menu.exportEpub': '导出 EPUB…',
    'menu.backups': '打开备份目录',
    'menu.logs': '打开日志目录',
    'menu.quit': '退出',
    'menu.close': '关闭',
    'menu.find': '查找…',
    'menu.outline': '切换大纲',
    'menu.about': '关于 mdpad',
    'menu.checkUpdates': '检查更新…',
    'menu.empty': '（空）',

    'dialog.unsavedTitle': '未保存的修改',
    'dialog.unsavedMessage': '有 {count} 个文档尚未保存',
    'dialog.unsavedDetail': '关闭会把这些内容保留为恢复草稿；下次打开该文件时会提示恢复。',
    'dialog.keepEditing': '继续编辑',
    'dialog.closeKeepDrafts': '关闭并保留草稿',
    'dialog.saveFailedTitle': '保存失败',
    'dialog.saveFailedMessage': '无法保存文档',
    'dialog.retry': '重试',
    'dialog.saveAs': '另存为…',
    'dialog.cancel': '取消',
    'dialog.ok': '好',
    'dialog.updateTitle': 'mdpad 更新',
    'dialog.updateAvailable': '有新版本可用',
    'dialog.upToDate': '已是最新版本',
    'dialog.updateFailed': '检查更新失败',
    'dialog.aboutDetail': 'Electron {electron}\nChromium {chromium}\nNode {node}\n\n数据目录：{data}',

    'ui.find': '查找',
    'ui.open': '打开',
    'ui.save': '保存',
    'ui.exportHtml': 'HTML',
    'ui.exportPdf': 'PDF',
    'ui.settings': '设置',
    'ui.theme': '主题',
    'ui.themeLight': '浅色',
    'ui.themeDark': '深色',
    'ui.themeSepia': '护眼',

    'empty.title': 'mdpad',
    'empty.subtitle': '一个不怕崩溃和中断的 Markdown 编辑器',
    'empty.new': '新建文档',
    'empty.folder': '打开文件夹',
    'empty.ai': '试试 AI 写作',
    'empty.tip': 'Ctrl+Shift+P 打开命令面板 · F1 查看快捷键',

    'settings.title': '设置',
    'settings.theme': '主题',
    'settings.autosave': '自动保存（秒）',
    'settings.language': '界面语言',
    'settings.aiSection': 'AI 写作',
    'settings.endpoint': '接口地址',
    'settings.model': '模型',
    'settings.apiKey': 'API Key',
    'settings.keySaved': '密钥已保存在系统凭据存储中。',
    'settings.keyWeak': '密钥已保存，但只是编码处理——系统凭据存储不可用。',
    'settings.noKey': '尚未保存密钥。',
    'settings.save': '保存',
    'settings.cancel': '取消',
    'settings.saved': '已保存',

    'ai.run': '生成',
    'ai.retry': '重试',
    'ai.stop': '停止',
    'ai.insert': '插入',
    'ai.replace': '替换选区',
    'ai.preview': '预览改动',
    'ai.clear': '清空上下文',
    'ai.instruction': '指令——续写、精简、翻译、转成表格…',
    'ai.resultPlaceholder': '结果会流式出现在这里，确认后再插入',

    'stats.title': '文档统计',
    'stats.close': '关闭',
    'palette.placeholder': '输入命令…',
  },
};

const LANGS = ['en', 'zh'];

function normalizeLang(lang) {
  const value = String(lang || '').toLowerCase();
  if (value.startsWith('zh')) return 'zh';
  return 'en';
}

function t(key, lang = 'en', vars = {}) {
  const table = DICT[lang] || DICT.en;
  let template = table[key];
  if (template === undefined) template = DICT.en[key];
  if (template === undefined) return key;
  return String(template).replace(/\{(\w+)\}/g, (_match, name) =>
    vars[name] === undefined ? `{${name}}` : String(vars[name])
  );
}

Object.assign(DICT.en, {
  'palette.save': 'Save',
  'palette.saveAs': 'Save As…',
  'palette.open': 'Open File…',
  'palette.openFolder': 'Open Folder…',
  'palette.newTab': 'New Tab',
  'palette.find': 'Find & Replace',
  'palette.outline': 'Toggle Outline',
  'palette.ai': 'AI Writing',
  'palette.settings': 'Settings',
  'palette.shortcuts': 'Keyboard Shortcuts',
  'palette.stats': 'Document Statistics',
  'palette.exportHtml': 'Export HTML…',
  'palette.exportPdf': 'Export PDF…',
  'palette.exportWord': 'Export Word…',
  'palette.exportEpub': 'Export EPUB…',
  'palette.themeLight': 'Theme: Light',
  'palette.themeDark': 'Theme: Dark',
  'palette.themeSepia': 'Theme: Sepia',

  'stats.words': 'Words',
  'stats.characters': 'Characters',
  'stats.noSpaces': 'Characters (no spaces)',
  'stats.paragraphs': 'Paragraphs',
  'stats.headings': 'Headings',
  'stats.images': 'Images',
  'stats.reading': 'Reading time',
  'stats.minutes': '~{count} min',

  'shortcuts.title': 'Keyboard shortcuts',
  'shortcuts.close': 'Close',
  'sc.newDoc': 'New document / new tab',
  'sc.open': 'Open file / open folder',
  'sc.save': 'Save / save as',
  'sc.find': 'Find & replace',
  'sc.ai': 'AI writing',
  'sc.settings': 'Settings',
  'sc.palette': 'Command palette',
  'sc.outline': 'Toggle outline',
  'sc.newWindow': 'New window',
  'sc.export': 'Export HTML / PDF',
  'sc.moveBlock': 'Move the current block',
  'sc.help': 'This list',

  'ai.presetContinue': 'Continue',
  'ai.presetTighten': 'Tighten',
  'ai.presetEn': '→ EN',
  'ai.presetZh': '→ 中文',
  'ai.presetSummarize': 'Summarize',
  'ai.presetTable': 'Table',

  'settings.exportTemplate': 'Export template',
  'template.default': 'Default',
  'template.compact': 'Compact',
  'template.toc': 'With table of contents',

  'menu.exportSettings': 'Export Settings…',
  'menu.importSettings': 'Import Settings…',
  'settings.exportTitle': 'Export settings',
  'settings.importTitle': 'Import settings',
  'settings.importFailed': 'That file is not a valid mdpad settings file',
});

Object.assign(DICT.zh, {
  'palette.save': '保存',
  'palette.saveAs': '另存为…',
  'palette.open': '打开文件…',
  'palette.openFolder': '打开文件夹…',
  'palette.newTab': '新建标签页',
  'palette.find': '查找替换',
  'palette.outline': '切换大纲',
  'palette.ai': 'AI 写作',
  'palette.settings': '设置',
  'palette.shortcuts': '快捷键',
  'palette.stats': '文档统计',
  'palette.exportHtml': '导出 HTML…',
  'palette.exportPdf': '导出 PDF…',
  'palette.exportWord': '导出 Word…',
  'palette.exportEpub': '导出 EPUB…',
  'palette.themeLight': '主题：浅色',
  'palette.themeDark': '主题：深色',
  'palette.themeSepia': '主题：护眼',

  'stats.words': '字数',
  'stats.characters': '字符数',
  'stats.noSpaces': '字符数（不含空格）',
  'stats.paragraphs': '段落数',
  'stats.headings': '标题数',
  'stats.images': '图片数',
  'stats.reading': '阅读时长',
  'stats.minutes': '约 {count} 分钟',

  'shortcuts.title': '快捷键',
  'shortcuts.close': '关闭',
  'sc.newDoc': '新建文档 / 新标签页',
  'sc.open': '打开文件 / 打开文件夹',
  'sc.save': '保存 / 另存为',
  'sc.find': '查找替换',
  'sc.ai': 'AI 写作',
  'sc.settings': '设置',
  'sc.palette': '命令面板',
  'sc.outline': '切换大纲',
  'sc.newWindow': '新建窗口',
  'sc.export': '导出 HTML / PDF',
  'sc.moveBlock': '移动当前块',
  'sc.help': '快捷键列表',

  'ai.presetContinue': '续写',
  'ai.presetTighten': '精简',
  'ai.presetEn': '→ 英文',
  'ai.presetZh': '→ 中文',
  'ai.presetSummarize': '摘要',
  'ai.presetTable': '表格',

  'settings.exportTemplate': '导出模板',
  'template.default': '默认',
  'template.compact': '紧凑',
  'template.toc': '带目录',

  'menu.exportSettings': '导出设置…',
  'menu.importSettings': '导入设置…',
  'settings.exportTitle': '导出设置',
  'settings.importTitle': '导入设置',
  'settings.importFailed': '该文件不是有效的 mdpad 设置文件',
});

Object.assign(DICT.en, {
  'error.permission': 'No permission to write this file ({detail})',
  'error.diskFull': 'The disk is full ({detail})',
  'error.notFound': 'The file or folder no longer exists ({detail})',
  'error.pathConflict': 'That path is not a valid file target ({detail})',
  'error.busy': 'The file is in use by another program ({detail})',
  'error.pathTooLong': 'The path is too long ({detail})',
  'error.unknown': 'Write failed ({detail})',
});

Object.assign(DICT.zh, {
  'error.permission': '没有写入权限（{detail}）',
  'error.diskFull': '磁盘已满（{detail}）',
  'error.notFound': '文件或目录已不存在（{detail}）',
  'error.pathConflict': '该路径不能作为文件写入目标（{detail}）',
  'error.busy': '文件正被其他程序占用（{detail}）',
  'error.pathTooLong': '路径过长（{detail}）',
  'error.unknown': '写入失败（{detail}）',
});

Object.assign(DICT.en, {
  'settings.aiPreset': 'Provider',
  'preset.custom': 'Custom',
});

Object.assign(DICT.zh, {
  'settings.aiPreset': '服务商',
  'preset.custom': '自定义',
});

Object.assign(DICT.en, {
  'ai.confirm': 'This request is about {tokens} tokens. Send anyway?',
  'ai.send': 'Send',
  'ai.cancel': 'Cancel',
  'settings.aiConfirm': 'Confirm above (tokens)',
});

Object.assign(DICT.zh, {
  'ai.confirm': '这次请求约 {tokens} tokens，确定发送吗？',
  'ai.send': '发送',
  'ai.cancel': '取消',
  'settings.aiConfirm': '超过该 token 数先确认',
});

Object.assign(DICT.en, {
  'crash.withDrafts': 'mdpad closed unexpectedly last time. {count} recovery draft(s) are waiting.',
  'crash.noDrafts': 'mdpad closed unexpectedly last time.',
  'crash.open': 'Show drafts',
  'crash.dismiss': 'Dismiss',
});

Object.assign(DICT.zh, {
  'crash.withDrafts': '上次 mdpad 没有正常退出，有 {count} 份恢复草稿待处理。',
  'crash.noDrafts': '上次 mdpad 没有正常退出。',
  'crash.open': '打开草稿目录',
  'crash.dismiss': '知道了',
});

Object.assign(DICT.en, {
  'settings.usage': 'Usage',
  'usage.empty': 'No requests yet.',
  'usage.row': '~{prompt} in / {out} out · {ms} ms · {model}',
});

Object.assign(DICT.zh, {
  'settings.usage': '用量',
  'usage.empty': '还没有请求记录。',
  'usage.row': '输入约 {prompt} / 输出 {out} · {ms} 毫秒 · {model}',
});

Object.assign(DICT.en, {
  'settings.exportCss': 'Custom CSS for exports',
});

Object.assign(DICT.zh, {
  'settings.exportCss': '导出时追加的 CSS',
});

Object.assign(DICT.en, {
  'settings.errorUrl': 'The endpoint must start with http:// or https://',
  'settings.errorAutosave': 'Autosave must be between 1 and 60 seconds',
  'settings.errorTokens': 'The token threshold must be between 0 and 500000',
});

Object.assign(DICT.zh, {
  'settings.errorUrl': '接口地址必须以 http:// 或 https:// 开头',
  'settings.errorAutosave': '自动保存间隔需在 1–60 秒之间',
  'settings.errorTokens': 'token 阈值需在 0–500000 之间',
});

Object.assign(DICT.en, {
  'menu.preview': 'Preview Export',
  'preview.title': 'Export preview',
  'palette.previewExport': 'Preview Export',
  'session.restored': 'Restored {count} tabs',
});

Object.assign(DICT.zh, {
  'menu.preview': '预览导出',
  'preview.title': '导出预览',
  'palette.previewExport': '预览导出',
  'session.restored': '已恢复 {count} 个标签',
});

Object.assign(DICT.en, {
  'ai.contextFull': 'context: {total} chars',
  'ai.contextTrimmed': 'context: {used} of {total} chars (trimmed)',
  'ai.selectionNote': 'selection: {count} chars',
});

Object.assign(DICT.zh, {
  'ai.contextFull': '上下文：{total} 字符',
  'ai.contextTrimmed': '上下文：{used} / {total} 字符（已截断）',
  'ai.selectionNote': '选区：{count} 字符',
});

Object.assign(DICT.en, {
  'preflight.failed': 'The data folder is not writable ({detail}). Saves will fail until this is fixed.',
});

Object.assign(DICT.zh, {
  'preflight.failed': '数据目录不可写（{detail}），在修复前保存会失败。',
});

Object.assign(DICT.en, {
  'settings.aiSystem': 'Writing style guidance',
});

Object.assign(DICT.zh, {
  'settings.aiSystem': '写作风格要求',
});

Object.assign(DICT.en, {
  'status.backups': '{count} backups',
  'status.noBackups': 'no backups yet',
});

Object.assign(DICT.zh, {
  'status.backups': '{count} 个备份',
  'status.noBackups': '暂无备份',
});

Object.assign(DICT.en, {
  'style.concise': 'Concise',
  'style.academic': 'Academic',
  'style.marketing': 'Marketing',
  'style.friendly': 'Friendly',
});

Object.assign(DICT.zh, {
  'style.concise': '简洁',
  'style.academic': '学术',
  'style.marketing': '营销',
  'style.friendly': '亲和',
});

Object.assign(DICT.en, {
  'backup.title': 'Restore a backup',
  'backup.empty': 'No backups for this file yet.',
  'backup.restored': 'Backup loaded into the editor — save to keep it.',
  'backup.item': '{time} · {size} KB',
});

Object.assign(DICT.zh, {
  'backup.title': '从备份恢复',
  'backup.empty': '这个文件还没有备份。',
  'backup.restored': '备份已载入编辑器，保存后生效。',
  'backup.item': '{time} · {size} KB',
});

Object.assign(DICT.en, {
  'preview.note': 'Preview — page breaks here may differ from the exported PDF.',
});

Object.assign(DICT.zh, {
  'preview.note': '预览 — 这里的分页可能与实际导出的 PDF 不完全一致。',
});

Object.assign(DICT.en, {
  'settings.filter': 'Filter settings…',
});

Object.assign(DICT.zh, {
  'settings.filter': '筛选设置项…',
});

Object.assign(DICT.en, {
  'palette.closeTab': 'Close Tab',
});

Object.assign(DICT.zh, {
  'palette.closeTab': '关闭标签页',
});

Object.assign(DICT.en, {
  'ai.scopeLabel': 'Context',
  'ai.scopeDoc': 'Whole document',
  'ai.scopeParagraph': 'Current paragraph',
  'ai.scopeNone': 'Selection only',
  'ai.contextNone': 'no document context',
});

Object.assign(DICT.zh, {
  'ai.scopeLabel': '上下文',
  'ai.scopeDoc': '整篇文档',
  'ai.scopeParagraph': '当前段落',
  'ai.scopeNone': '仅选区',
  'ai.contextNone': '不带文档上下文',
});

Object.assign(DICT.en, {
  'export.largeWarning': 'Exported file is {size}. Large images make exports heavy — consider shrinking them.',
});

Object.assign(DICT.zh, {
  'export.largeWarning': '导出文件有 {size}，主要是图片较大，建议先压缩。',
});

Object.assign(DICT.en, {
  'ai.copy': 'Copy',
  'ai.copied': 'result copied',
  'status.exporting': 'exporting {kind}…',
});

Object.assign(DICT.zh, {
  'ai.copy': '复制',
  'ai.copied': '已复制结果',
  'status.exporting': '正在导出 {kind}…',
});

Object.assign(DICT.en, {
  'firstRun.text': 'New here? Ctrl+J opens AI writing (configure it in Settings), and Help → Check for Updates looks for a newer build.',
  'firstRun.setup': 'Set up AI',
  'firstRun.gotIt': 'Got it',
});

Object.assign(DICT.zh, {
  'firstRun.text': '第一次使用？Ctrl+J 打开 AI 写作（在设置里配置），帮助 → 检查更新 可查看新版本。',
  'firstRun.setup': '配置 AI',
  'firstRun.gotIt': '知道了',
});

Object.assign(DICT.en, {
  'export.stats': '{words} words · {chars} characters',
});

Object.assign(DICT.zh, {
  'export.stats': '{words} 词 · {chars} 字符',
});

Object.assign(DICT.en, {
  'settings.exportName': 'Export file name',
});

Object.assign(DICT.zh, {
  'settings.exportName': '导出文件名',
});

Object.assign(DICT.en, {
  'ai.contextSuggest': 'long document — Current paragraph sends less',
});

Object.assign(DICT.zh, {
  'ai.contextSuggest': '文档较长 — 建议改用「当前段落」',
});

Object.assign(DICT.en, {
  'usage.export': 'Export CSV',
});

Object.assign(DICT.zh, {
  'usage.export': '导出 CSV',
});

Object.assign(DICT.en, {
  'session.truncated': '{count} tab(s) were not restored (limit reached or file missing)',
});

Object.assign(DICT.zh, {
  'session.truncated': '有 {count} 个标签未恢复（超出上限或文件已不存在）',
});

Object.assign(DICT.en, {
  'palette.reopenTab': 'Reopen Closed Tab',
});

Object.assign(DICT.zh, {
  'palette.reopenTab': '重新打开关闭的标签',
});

Object.assign(DICT.en, {
  'drafts.title': 'Recovery drafts',
  'drafts.empty': 'No drafts to recover.',
  'drafts.close': 'Close',
  'drafts.item': '{time} · {size} chars',
  'drafts.menu': 'Recover Drafts…',
});

Object.assign(DICT.zh, {
  'drafts.title': '恢复草稿',
  'drafts.empty': '没有可恢复的草稿。',
  'drafts.close': '关闭',
  'drafts.item': '{time} · {size} 字符',
  'drafts.menu': '恢复草稿…',
});

Object.assign(DICT.en, {
  'menu.recoverDrafts': 'Recover Drafts…',
});

Object.assign(DICT.zh, {
  'menu.recoverDrafts': '恢复草稿…',
});

Object.assign(DICT.en, {
  'drafts.badge': '{count} drafts',
});

Object.assign(DICT.zh, {
  'drafts.badge': '{count} 份草稿',
});

Object.assign(DICT.en, {
  'ai.test': 'Test connection',
  'ai.testing': 'testing…',
  'ai.testOk': 'connected in {ms} ms',
  'ai.testFail': 'connection failed: {error}',
});

Object.assign(DICT.zh, {
  'ai.test': '测试连接',
  'ai.testing': '测试中…',
  'ai.testOk': '{ms} 毫秒内连接成功',
  'ai.testFail': '连接失败：{error}',
});

Object.assign(DICT.en, {
  'palette.recentPrefix': 'Open recent:',
});

Object.assign(DICT.zh, {
  'palette.recentPrefix': '最近打开：',
});

Object.assign(DICT.en, {
  'drafts.purge': 'Clean up old drafts',
  'drafts.purgeMessage': 'Delete {count} draft(s) older than {days} days? This cannot be undone.',
  'drafts.purgeConfirm': 'Delete',
  'drafts.purged': 'removed {count} old draft(s)',
});

Object.assign(DICT.zh, {
  'drafts.purge': '清理旧草稿',
  'drafts.purgeMessage': '删除 {count} 份超过 {days} 天的草稿？此操作无法撤销。',
  'drafts.purgeConfirm': '删除',
  'drafts.purged': '已删除 {count} 份旧草稿',
});

Object.assign(DICT.en, {
  'stats.savedAt': 'Last saved',
  'stats.neverSaved': 'not saved yet',
});

Object.assign(DICT.zh, {
  'stats.savedAt': '上次保存',
  'stats.neverSaved': '尚未保存',
});

Object.assign(DICT.en, {
  'ai.insertParagraph': 'New paragraph',
});

Object.assign(DICT.zh, {
  'ai.insertParagraph': '新段落',
});

Object.assign(DICT.en, {
  'settings.fetchModels': 'Fetch models',
});

Object.assign(DICT.zh, {
  'settings.fetchModels': '获取模型列表',
});

Object.assign(DICT.en, {
  'outline.empty': 'Headings will appear here',
});

Object.assign(DICT.zh, {
  'outline.empty': '标题将显示在这里',
});

Object.assign(DICT.en, {
  'stats.selection': 'Selection',
  'stats.noSelection': 'nothing selected',
  'stats.charsSelected': '{count} characters',
});

Object.assign(DICT.zh, {
  'stats.selection': '选中内容',
  'stats.noSelection': '未选中',
  'stats.charsSelected': '{count} 个字符',
});

Object.assign(DICT.en, {
  'palette.focusMode': 'Toggle focus mode',
});

Object.assign(DICT.zh, {
  'palette.focusMode': '切换专注模式',
});

Object.assign(DICT.en, {
  'menu.focusMode': 'Focus Mode',
});

Object.assign(DICT.zh, {
  'menu.focusMode': '专注模式',
});

Object.assign(DICT.en, {
  'settings.previewExport': 'Preview export',
});

Object.assign(DICT.zh, {
  'settings.previewExport': '预览导出效果',
});

Object.assign(DICT.en, {
  'settings.unsaved': 'Unsaved changes',
});

Object.assign(DICT.zh, {
  'settings.unsaved': '有未保存的修改',
});

Object.assign(DICT.en, {
  'sc.preview': 'Preview the export',
  'sc.focusMode': 'Toggle focus mode',
  'sc.tabs': 'Close tab / reopen the last closed tab',
});

Object.assign(DICT.zh, {
  'sc.preview': '预览导出效果',
  'sc.focusMode': '切换专注模式',
  'sc.tabs': '关闭标签 / 恢复上一个关闭的标签',
});

Object.assign(DICT.en, {
  'palette.aiUsage': 'Open AI usage log',
});

Object.assign(DICT.zh, {
  'palette.aiUsage': '打开 AI 使用记录',
});

Object.assign(DICT.en, {
  'drafts.deleteConfirm': 'Delete',
  'drafts.deleteMessage': 'Delete the draft for {name}? This cannot be undone.',
  'drafts.deleted': 'draft deleted',
});

Object.assign(DICT.zh, {
  'drafts.deleteConfirm': '删除',
  'drafts.deleteMessage': '删除 {name} 的草稿？此操作无法撤销。',
  'drafts.deleted': '已删除草稿',
});

Object.assign(DICT.en, {
  'settings.exportSection': 'Export',
});

Object.assign(DICT.zh, {
  'settings.exportSection': '导出',
});

Object.assign(DICT.en, {
  'menu.fullscreen': 'Full Screen',
});

Object.assign(DICT.zh, {
  'menu.fullscreen': '全屏',
});

Object.assign(DICT.en, {
  'font.serif': 'Georgia (book)',
  'font.sans': 'Segoe UI',
  'font.yahei': 'Microsoft YaHei',
  'font.simsun': 'SimSun',
  'font.kaiti': 'KaiTi',
  'font.fangsong': 'FangSong',
  'font.times': 'Times New Roman',
  'font.arial': 'Arial',
  'font.cambria': 'Cambria',
  'font.mono': 'Consolas',
  'export.open': 'Open',
  'export.reveal': 'Show in folder',
  'export.done': 'exported {name}',
});

Object.assign(DICT.zh, {
  'font.serif': 'Georgia（衬线）',
  'font.sans': 'Segoe UI（无衬线）',
  'font.yahei': '微软雅黑',
  'font.simsun': '宋体',
  'font.kaiti': '楷体',
  'font.fangsong': '仿宋',
  'font.times': 'Times New Roman',
  'font.arial': 'Arial',
  'font.cambria': 'Cambria',
  'font.mono': 'Consolas（等宽）',
  'export.open': '打开文件',
  'export.reveal': '打开所在文件夹',
  'export.done': '已导出 {name}',
});

Object.assign(DICT.en, {
  'settings.preset': 'Typography preset',
  'preset.custom': 'Custom',
  'preset.book': 'Book — serif, warm accent',
  'preset.report': 'Report — Cambria, blue',
  'preset.minimal': 'Minimal — Sans, wide',
  'preset.technical': 'Technical — Arial, teal',
  'preset.chinese': 'Chinese — Microsoft YaHei',
});

Object.assign(DICT.zh, {
  'settings.preset': '排版预设',
  'preset.custom': '自定义',
  'preset.book': '书籍 — 衬线，暖色',
  'preset.report': '报告 — Cambria，蓝色',
  'preset.minimal': '极简 — 无衬线，宽版心',
  'preset.technical': '技术文档 — Arial，青绿',
  'preset.chinese': '中文 — 微软雅黑',
});

Object.assign(DICT.en, {
  'settings.navAppearance': 'Appearance',
  'settings.navExport': 'Export',
  'settings.navAi': 'AI writing',
  'settings.navUsage': 'Usage',
  'settings.apiKeyPlaceholder': 'sk-…',
  'settings.clearKey': 'Clear',
  'settings.appearanceSection': 'Appearance',
});

Object.assign(DICT.zh, {
  'settings.navAppearance': '外观',
  'settings.navExport': '导出',
  'settings.navAi': 'AI 写作',
  'settings.navUsage': '用量',
  'settings.apiKeyPlaceholder': 'sk-…',
  'settings.clearKey': '清除',
  'settings.appearanceSection': '外观',
});

Object.assign(DICT.en, {
  'ui.appearance': 'Font, width and colour',
  'cmd.appearance': 'Change font and page width',
});

Object.assign(DICT.zh, {
  'ui.appearance': '字体、版心与配色',
  'cmd.appearance': '调整字体与版心宽度',
});

Object.assign(DICT.en, {
  'export.title': 'Export',
  'export.format': 'Format',
  'export.word': 'Word',
  'export.font': 'Document font',
  'export.margins': 'Page margins',
  'export.marginNarrow': 'Narrow',
  'export.marginNormal': 'Normal',
  'export.marginWide': 'Wide',
  'export.preview': 'Preview',
  'export.run': 'Export',
});

Object.assign(DICT.zh, {
  'export.title': '导出',
  'export.format': '格式',
  'export.word': 'Word',
  'export.font': '文档字体',
  'export.margins': '页边距',
  'export.marginNarrow': '窄',
  'export.marginNormal': '标准',
  'export.marginWide': '宽',
  'export.preview': '预览',
  'export.run': '导出',
});

Object.assign(DICT.en, {
  'ai.title': 'AI writing',
});

Object.assign(DICT.zh, {
  'ai.title': 'AI 写作',
});

Object.assign(DICT.en, {
  'menu.split': 'Split into Two Windows',
  'menu.splitNeedsFile': 'Save the document first, then split it into two windows.',
  'palette.split': 'Split into two windows',
});

Object.assign(DICT.zh, {
  'menu.split': '分成两个窗口并排',
  'menu.splitNeedsFile': '请先保存文档，再分成两个窗口。',
  'palette.split': '分成两个窗口并排',
});

Object.assign(DICT.en, {
  'menu.splitFailed': 'The window could not be split.',
});

Object.assign(DICT.zh, {
  'menu.splitFailed': '无法分屏。',
});

Object.assign(DICT.en, {
  'menu.unsplit': 'Merge the Split Windows',
  'palette.unsplit': 'Merge the split windows',
});

Object.assign(DICT.zh, {
  'menu.unsplit': '合并分屏窗口',
  'palette.unsplit': '合并分屏窗口',
});

Object.assign(DICT.en, {
  'menu.unsplitFailed': 'These windows are not split.',
});

Object.assign(DICT.zh, {
  'menu.unsplitFailed': '当前窗口不是分屏状态。',
});

Object.assign(DICT.en, {
  'settings.spellcheck': 'Check spelling',
});

Object.assign(DICT.zh, {
  'settings.spellcheck': '拼写检查',
});

Object.assign(DICT.en, {
  'theme.system': 'Follow system',
});

Object.assign(DICT.zh, {
  'theme.system': '跟随系统',
});

Object.assign(DICT.en, {
  'menu.copyDiagnostics': 'Copy Diagnostics',
  'menu.openLogFolder': 'Open Log Folder',
  'settings.diagnostics': 'Copy diagnostics',
  'settings.diagnosticsHint': 'Version, paths and the last log lines, for a bug report.',
  'settings.diagnosticsCopied': 'Diagnostics copied to the clipboard',
});

Object.assign(DICT.zh, {
  'menu.copyDiagnostics': '复制诊断信息',
  'menu.openLogFolder': '打开日志文件夹',
  'settings.diagnostics': '复制诊断信息',
  'settings.diagnosticsHint': '版本、路径和最近的日志，用于反馈问题。',
  'settings.diagnosticsCopied': '诊断信息已复制到剪贴板',
});

Object.assign(DICT.en, {
  'empty.new': 'Start writing',
  'empty.newHint': 'Ctrl+N makes another tab',
  'empty.folderHint': 'Your markdown files appear in the tree',
  'empty.block': 'Insert a block',
  'empty.blockHint': 'Type / for headings, tables, diagrams',
  'empty.export': 'Export',
  'empty.exportHint': 'PDF, Word, HTML, EPUB and images',
  'empty.skip': 'Skip the guide',
  'menu.welcome': 'Welcome Guide',
});

Object.assign(DICT.zh, {
  'empty.new': '开始写',
  'empty.newHint': 'Ctrl+N 新建标签页',
  'empty.folderHint': '文件夹里的 Markdown 会显示在左侧',
  'empty.block': '插入块',
  'empty.blockHint': '输入 / 插入标题、表格、图表',
  'empty.export': '导出',
  'empty.exportHint': 'PDF、Word、HTML、EPUB 和图片',
  'empty.skip': '跳过引导',
  'menu.welcome': '欢迎引导',
});

Object.assign(DICT.en, {
  'settings.navAdvanced': 'Advanced',
  'settings.exportSettings': 'Export settings…',
  'settings.importSettings': 'Import settings…',
  'settings.exportHint': 'A JSON file with your preferences. The AI key is never included.',
  'settings.exported': 'Settings written to {name}',
  'settings.imported': 'Imported {count} settings ({ignored} ignored)',
  'settings.openData': 'Open data folder',
  'settings.clearDrafts': 'Clear recovery drafts',
  'settings.clear': 'Clear',
  'settings.clearDraftsText': 'Delete all {count} recovery drafts? Unsaved text from closed tabs will be lost.',
  'settings.draftsCleared': 'Deleted {count} drafts',
  'settings.noDrafts': 'No recovery drafts to clear',
  'settings.reset': 'Reset all settings…',
  'settings.resetHint': 'Resets preferences only. Files, backups and drafts on disk are not touched.',
  'settings.resetText': 'Reset every preference to its default? Your documents, backups and drafts stay on disk.',
  'settings.resetConfirm': 'Reset',
  'settings.resetDone': 'Settings reset',
});

Object.assign(DICT.zh, {
  'settings.navAdvanced': '高级',
  'settings.exportSettings': '导出设置…',
  'settings.importSettings': '导入设置…',
  'settings.exportHint': '包含偏好的 JSON 文件。AI 密钥不会写入。',
  'settings.exported': '设置已写入 {name}',
  'settings.imported': '已导入 {count} 项设置（忽略 {ignored} 项）',
  'settings.openData': '打开数据文件夹',
  'settings.clearDrafts': '清空恢复草稿',
  'settings.clear': '清空',
  'settings.clearDraftsText': '删除全部 {count} 份恢复草稿？已关闭标签页中的未保存内容将会丢失。',
  'settings.draftsCleared': '已删除 {count} 份草稿',
  'settings.noDrafts': '没有可清理的恢复草稿',
  'settings.reset': '重置全部设置…',
  'settings.resetHint': '只重置偏好，磁盘上的文件、备份和草稿不受影响。',
  'settings.resetText': '将所有偏好恢复默认？文件、备份和草稿仍保留在磁盘上。',
  'settings.resetConfirm': '重置',
  'settings.resetDone': '设置已重置',
});

Object.assign(DICT.en, {
  'menu.extractImages': 'Extract Embedded Images…',
  'dialog.extractTitle': 'Embedded images',
  'dialog.extractNone': 'This document has no embedded images to extract.',
  'dialog.extracted': 'Moved {count} image(s) to assets/',
});

Object.assign(DICT.zh, {
  'menu.extractImages': '提取内嵌图片…',
  'dialog.extractTitle': '内嵌图片',
  'dialog.extractNone': '这个文档没有可提取的内嵌图片。',
  'dialog.extracted': '已移动 {count} 张图片到 assets/',
});

Object.assign(DICT.en, {
  'recent.title': 'Recent files',
  'recent.empty': 'No recent files yet. Open one and it will show up here.',
  'recent.missing': 'missing',
  'recent.open': 'Open',
  'recent.remove': 'Remove from list',
  'recent.clear': 'Clear list',
  'recent.clearConfirm': 'Remove every entry from the recent list? The files stay on disk.',
  'recent.gone': 'That file no longer exists',
  'menu.recentAll': 'Show All Recent Files…',
  'palette.recent': 'Recent files…',
});

Object.assign(DICT.zh, {
  'recent.title': '最近文件',
  'recent.empty': '还没有最近文件。打开一个文件后会出现在这里。',
  'recent.missing': '已丢失',
  'recent.open': '打开',
  'recent.remove': '从列表移除',
  'recent.clear': '清空列表',
  'recent.clearConfirm': '清空最近文件列表？磁盘上的文件不会被删除。',
  'recent.gone': '该文件已不存在',
  'menu.recentAll': '显示全部最近文件…',
  'palette.recent': '最近文件…',
});

module.exports = { t, normalizeLang, LANGS, DICT };

Object.assign(DICT.en, {
  'menu.fullscreen': 'Full Screen',
  'settings.font': 'Editor font',
  'settings.width': 'Text width',
  'settings.accent': 'Accent colour',
  'font.serif': 'Georgia (book)',
  'font.sans': 'Segoe UI',
  'font.mono': 'Monospace',
  'width.narrow': 'Narrow (34 rem)',
  'width.normal': 'Normal (46 rem)',
  'width.wide': 'Wide (58 rem)',
  'accent.blue': 'Blue',
  'accent.teal': 'Teal',
  'accent.violet': 'Violet',
  'accent.amber': 'Amber',
  'files.hide': 'Hide the file tree',
  'image.label': 'Image',
  'table.label': 'Table',
  'table.rowAbove': '+ row above',
  'table.rowBelow': '+ row below',
  'table.colLeft': '+ column left',
  'table.colRight': '+ column right',
  'table.deleteRow': '− row',
  'table.deleteCol': '− column',
  'table.deleteTable': 'delete table',
  'table.alignLeft': 'Align left',
  'table.alignCenter': 'Align centre',
  'table.alignRight': 'Align right',
});

Object.assign(DICT.zh, {
  'menu.fullscreen': '全屏',
  'settings.font': '编辑字体',
  'settings.width': '版心宽度',
  'settings.accent': '强调色',
  'font.serif': 'Georgia（衬线）',
  'font.sans': 'Segoe UI（无衬线）',
  'font.mono': '等宽',
  'width.narrow': '窄（34 rem）',
  'width.normal': '标准（46 rem）',
  'width.wide': '宽（58 rem）',
  'accent.blue': '蓝色',
  'accent.teal': '青绿',
  'accent.violet': '紫色',
  'accent.amber': '琥珀',
  'files.hide': '隐藏文件树',
  'image.label': '图片',
  'table.label': '表格',
  'table.rowAbove': '+ 上方插入行',
  'table.rowBelow': '+ 下方插入行',
  'table.colLeft': '+ 左侧插入列',
  'table.colRight': '+ 右侧插入列',
  'table.deleteRow': '− 删除行',
  'table.deleteCol': '− 删除列',
  'table.deleteTable': '删除表格',
  'table.alignLeft': '左对齐',
  'table.alignCenter': '居中',
  'table.alignRight': '右对齐',
});

Object.assign(DICT.en, { 'export.contents': 'Contents' });
Object.assign(DICT.zh, { 'export.contents': '目录' });

Object.assign(DICT.en, { 'editor.label': 'Document editor' });
Object.assign(DICT.zh, { 'editor.label': '文档编辑区' });

Object.assign(DICT.en, { 'tabs.label': 'Open documents' });
Object.assign(DICT.zh, { 'tabs.label': '打开的文档' });

Object.assign(DICT.en, {
  'table.moveRowUp': 'Move row up',
  'table.moveRowDown': 'Move row down',
  'table.moveColLeft': 'Move column left',
  'table.moveColRight': 'Move column right',
});
Object.assign(DICT.zh, {
  'table.moveRowUp': '上移一行',
  'table.moveRowDown': '下移一行',
  'table.moveColLeft': '左移一列',
  'table.moveColRight': '右移一列',
});

Object.assign(DICT.en, { 'settings.typewriter': 'Keep the caret in the middle' });
Object.assign(DICT.zh, { 'settings.typewriter': '光标保持居中' });

Object.assign(DICT.en, { 'settings.highlightParagraph': 'Highlight the current paragraph' });
Object.assign(DICT.zh, { 'settings.highlightParagraph': '高亮当前段落' });

Object.assign(DICT.en, { 'settings.writingGoal': 'Daily word goal (0 = off)' });
Object.assign(DICT.zh, { 'settings.writingGoal': '每日字数目标（0 为关闭）' });

Object.assign(DICT.en, {
  'settings.externalPolicy': 'When the file changes on disk',
  'settings.externalAsk': 'Ask me',
  'settings.externalAuto': 'Reload automatically',
  'settings.externalIgnore': 'Ignore',
});
Object.assign(DICT.zh, {
  'settings.externalPolicy': '文件在磁盘上被修改时',
  'settings.externalAsk': '询问我',
  'settings.externalAuto': '自动重新加载',
  'settings.externalIgnore': '忽略',
});

Object.assign(DICT.en, { 'settings.noMatches': 'No settings match.' });
Object.assign(DICT.zh, { 'settings.noMatches': '没有匹配的设置。' });

Object.assign(DICT.en, {
  'settings.paletteUsage': 'Command history',
  'settings.paletteClear': 'Clear',
  'settings.paletteHint': 'The palette puts commands you use first; clearing resets that order.',
  'settings.paletteCount': '{count} command(s) remembered',
});
Object.assign(DICT.zh, {
  'settings.paletteUsage': '命令历史',
  'settings.paletteClear': '清空',
  'settings.paletteHint': '命令面板会优先显示你常用的命令；清空后恢复原始顺序。',
  'settings.paletteCount': '已记住 {count} 条命令',
});

Object.assign(DICT.en, { 'menu.palette': 'Command Palette…' });
Object.assign(DICT.zh, { 'menu.palette': '命令面板…' });

Object.assign(DICT.en, {
  'shortcuts.filter': 'Filter shortcuts…',
  'shortcuts.noMatches': 'No shortcuts match.',
  'shortcuts.close': 'Close',
  'shortcuts.run': 'Run',
  'sc.closeTab': 'Close tab',
  'sc.reopenTab': 'Reopen the last closed tab',
  'sc.replace': 'Replace',
  'sc.boldItalic': 'Bold / italic',
  'sc.openFolder': 'Open folder',
  'sc.fullscreen': 'Full screen',
  'sc.zoom': 'Zoom in / out / reset',
  'sc.split': 'Split into two windows',
  'sc.unsplit': 'Merge the split windows',
  'sc.escape': 'Close the open dialog',
});
Object.assign(DICT.zh, {
  'shortcuts.filter': '筛选快捷键…',
  'shortcuts.noMatches': '没有匹配的快捷键。',
  'shortcuts.close': '关闭',
  'shortcuts.run': '运行',
  'sc.closeTab': '关闭标签',
  'sc.reopenTab': '重新打开刚关闭的标签',
  'sc.replace': '替换',
  'sc.boldItalic': '加粗 / 斜体',
  'sc.openFolder': '打开文件夹',
  'sc.fullscreen': '全屏',
  'sc.zoom': '放大 / 缩小 / 重置',
  'sc.split': '分屏为两个窗口',
  'sc.unsplit': '合并分屏窗口',
  'sc.escape': '关闭当前对话框',
});

Object.assign(DICT.en, {
  'hint.palette': 'Press Ctrl+Shift+P to run any command without leaving the keyboard.',
  'hint.shortcuts': 'F1 lists every shortcut; the list can run them too.',
  'hint.dropImage': 'Drop an image into the page to insert it, or paste one from the clipboard.',
  'hint.gotIt': 'Got it',
});
Object.assign(DICT.zh, {
  'hint.palette': '按 Ctrl+Shift+P 可以不开鼠标运行任何命令。',
  'hint.shortcuts': '按 F1 查看全部快捷键，列表里也能直接运行。',
  'hint.dropImage': '把图片拖进页面即可插入，也可以直接从剪贴板粘贴。',
  'hint.gotIt': '知道了',
});

Object.assign(DICT.en, {
  'stats.exportCsv': 'Export CSV',
  'stats.exportMd': 'Export Markdown',
  'stats.saved': 'Statistics saved',
});
Object.assign(DICT.zh, {
  'stats.exportCsv': '导出 CSV',
  'stats.exportMd': '导出 Markdown',
  'stats.saved': '统计已保存',
});

Object.assign(DICT.en, { 'menu.foldHeading': 'Fold / Unfold Heading' });
Object.assign(DICT.zh, { 'menu.foldHeading': '折叠 / 展开标题' });

Object.assign(DICT.en, {
  'export.scope': 'Range',
  'export.scopeDocument': 'Whole document',
  'export.scopeSection': 'Current section',
  'export.scopeNoSection': 'Put the caret in a heading to export that section.',
  'export.scopeAt': 'Only “{title}” and what is under it.',
});
Object.assign(DICT.zh, {
  'export.scope': '范围',
  'export.scopeDocument': '整篇文档',
  'export.scopeSection': '当前章节',
  'export.scopeNoSection': '请把光标放在标题里，才能导出该章节。',
  'export.scopeAt': '只导出「{title}」及其下的内容。',
});

Object.assign(DICT.en, {
  'export.copyPath': 'Copy path',
  'export.copied': 'Path copied',
  'export.openFailed': 'Could not open the file: {reason}',
  'export.revealFailed': 'Could not open the folder: {reason}',
  'export.done': 'Exported {name}',
  'export.open': 'Open',
  'export.reveal': 'Show in folder',
});
Object.assign(DICT.zh, {
  'export.copyPath': '复制路径',
  'export.copied': '路径已复制',
  'export.openFailed': '无法打开文件：{reason}',
  'export.revealFailed': '无法打开文件夹：{reason}',
  'export.done': '已导出 {name}',
  'export.open': '打开',
  'export.reveal': '在文件夹中显示',
});

Object.assign(DICT.en, {
  'export.history': 'Recent exports',
  'export.historyEmpty': 'Nothing exported yet.',
  'export.historyClear': 'Clear',
  'export.historyMissing': 'gone',
});
Object.assign(DICT.zh, {
  'export.history': '最近导出',
  'export.historyEmpty': '还没有导出记录。',
  'export.historyClear': '清空',
  'export.historyMissing': '文件已不存在',
});
