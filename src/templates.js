'use strict';

// Skeletons for a new document. Kept pure so the wording and structure can be tested, and so the
// renderer never builds markdown by hand.
//
// {date}, {time}, {title} and {cursor} are filled by the caller so the module stays deterministic.
// An unknown placeholder such as {project} is left in place: silently deleting it would lose the
// writer's own convention.

const TEMPLATES = [
  {
    id: 'blank',
    name: { en: 'Blank document', zh: '空白文档' },
    body: '',
  },
  {
    id: 'weekly',
    name: { en: 'Weekly report', zh: '周报' },
    body: [
      '# Weekly report — {date}',
      '',
      '## Done',
      '',
      '- ',
      '',
      '## In progress',
      '',
      '- ',
      '',
      '## Blocked / needs a decision',
      '',
      '- ',
      '',
      '## Next week',
      '',
      '- ',
      '',
    ].join('\n'),
  },
  {
    id: 'meeting',
    name: { en: 'Meeting notes', zh: '会议记录' },
    body: [
      '# Meeting notes — {date}',
      '',
      '- **Attendees:**',
      '- **Purpose:**',
      '',
      '## Agenda',
      '',
      '1. ',
      '',
      '## Notes',
      '',
      '- ',
      '',
      '## Decisions',
      '',
      '- ',
      '',
      '## Actions',
      '',
      '| Owner | Action | Due |',
      '| --- | --- | --- |',
      '|  |  |  |',
      '',
    ].join('\n'),
  },
  {
    id: 'longform',
    name: { en: 'Long-form skeleton', zh: '长文骨架' },
    body: [
      '# {title}',
      '',
      'One sentence that says what this piece argues.',
      '',
      '## Opening',
      '',
      'The situation, and why it matters now.',
      '',
      '## Point one',
      '',
      '## Point two',
      '',
      '## What could go wrong',
      '',
      '## Closing',
      '',
      'What the reader should do next.',
      '',
      '> Sources and notes go here until they earn a place in the text.',
      '',
    ].join('\n'),
  },
];

function listTemplates(lang = 'en') {
  return TEMPLATES.map((template) => ({ id: template.id, name: (template.name[lang] || template.name.en) }));
}

// Shared by built-in and custom templates: same placeholders, same rules.
function applyVariables(text, { date = '', time = '', title = 'Untitled' } = {}) {
  let body = String(text || '')
    .split('{date}').join(date)
    .split('{time}').join(time)
    .split('{title}').join(title);
  const at = body.indexOf('{cursor}');
  body = body.split('{cursor}').join('');
  return { body, cursor: at < 0 ? null : at };
}

function fillTemplate(id, { date = '', time = '', title = 'Untitled', lang = 'en' } = {}) {
  const template = TEMPLATES.find((entry) => entry.id === id) || TEMPLATES[0];
  const filled = applyVariables(template.body, { date, time, title });
  return {
    id: template.id,
    name: template.name[lang] || template.name.en,
    body: filled.body,
    cursor: filled.cursor,
  };
}

module.exports = { listTemplates, fillTemplate, applyVariables, TEMPLATES };
