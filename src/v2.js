// 디스코드 새 메시지 레이아웃(Components V2)으로 화면을 그린다.
//  - 직접 디자인한 화면: { v2: [컨테이너…] }
//  - 그 외 화면: { embeds, components } 를 카드 모양으로 자동 변환
// 이미지(차트·시세판·히트맵·아이콘)는 GitHub Pages 주소만 넣고, 디스코드가 직접 가져간다.

const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, SeparatorBuilder, SeparatorSpacingSize,
  MediaGalleryBuilder, MediaGalleryItemBuilder, ThumbnailBuilder, MessageFlags,
} = require('discord.js');
const { PAGES_URL } = require('./prices');

const COLOR_OK = 0x2f9e44;
const COLOR_ERR = 0xc92a2a;

const text = (content) => new TextDisplayBuilder().setContent(content);
const sep = (big = false) => new SeparatorBuilder().setDivider(true).setSpacing(big ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small);
const gap = () => new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);
const gallery = (...urls) => new MediaGalleryBuilder().addItems(...urls.map((u) => new MediaGalleryItemBuilder().setURL(u)));
const thumb = (url) => new ThumbnailBuilder().setURL(url);

function section(content, { thumbnail, button } = {}) {
  const s = new SectionBuilder().addTextDisplayComponents(text(content));
  if (button) s.setButtonAccessory(button);
  else if (thumbnail) s.setThumbnailAccessory(thumb(thumbnail));
  return s;
}

// 컨테이너에 여러 종류의 조각을 순서대로 넣는다
function container(color, parts) {
  const c = new ContainerBuilder();
  if (color != null) c.setAccentColor(color);
  for (const p of parts.filter(Boolean)) {
    if (p instanceof TextDisplayBuilder) c.addTextDisplayComponents(p);
    else if (p instanceof SectionBuilder) c.addSectionComponents(p);
    else if (p instanceof SeparatorBuilder) c.addSeparatorComponents(p);
    else if (p instanceof MediaGalleryBuilder) c.addMediaGalleryComponents(p);
    else c.addActionRowComponents(p);
  }
  return c;
}

function noticeContainer(notice) {
  return notice ? container(notice.error ? COLOR_ERR : COLOR_OK, [text(notice.text)]) : null;
}

// GitHub Pages 이미지 주소 (아직 한 번도 못 받았으면 null)
function pagesImage(state, name) {
  const v = state.market.chartsVersion;
  return v ? `${PAGES_URL}/charts/${encodeURIComponent(name)}.png?v=${v}` : null;
}

// 퍼센트 막대: ██████░░░░
function bar(ratio, width = 10) {
  const n = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `\`${'█'.repeat(n)}${'░'.repeat(width - n)}\``;
}

// ── 기존 임베드 화면 → 카드 자동 변환 ─────────────────────────

function embedToParts(e) {
  const parts = [];
  const head = [
    e.author && e.author.name ? `**${e.author.name}**` : null,
    e.title ? `### ${e.title}` : null,
    e.description || null,
  ].filter(Boolean).join('\n');
  const thumbUrl = (e.thumbnail && e.thumbnail.url) || (e.author && e.author.icon_url);
  if (head) parts.push(thumbUrl ? section(head, { thumbnail: thumbUrl }) : text(head));

  // 붙어 있는 inline 필드는 한 덩어리로, 나머지는 각자 한 덩어리로
  const fields = (e.fields || []).filter((f) => f.name !== '​' || f.value !== '​');
  let group = [];
  const flush = () => {
    if (!group.length) return;
    parts.push(text(group.map((f) => `**${f.name}** ${f.value.replace(/\n/g, ' · ')}`).join('\n')));
    group = [];
  };
  for (const f of fields) {
    if (f.inline) {
      group.push(f);
    } else {
      flush();
      parts.push(text(`**${f.name}**\n${f.value}`));
    }
  }
  flush();
  if (fields.length && parts.length > 1) parts.splice(1, 0, sep());
  if (e.image && e.image.url) parts.push(gallery(e.image.url));
  if (e.footer && e.footer.text) parts.push(text(`-# ${e.footer.text}`));
  return parts;
}

function convert(view) {
  const embeds = (view.embeds || []).map((e) => (typeof e.toJSON === 'function' ? e.toJSON() : e));
  const rows = view.components || [];
  const out = [];
  embeds.forEach((e, i) => {
    const isNotice = !e.title && !e.author && !(e.fields || []).length && embeds.length > 1 && i === 0;
    const parts = embedToParts(e);
    if (i === embeds.length - 1 && rows.length) parts.push(sep(), ...rows);
    out.push(container(isNotice ? e.color : e.color, parts));
  });
  if (!embeds.length && rows.length) out.push(container(null, rows));
  return out;
}

// 화면 → 메시지 내용
function render(view) {
  const components = view.v2 ? view.v2.filter(Boolean) : convert(view);
  const msg = { components, flags: MessageFlags.IsComponentsV2 };
  if (view.allowedMentions) msg.allowedMentions = view.allowedMentions;
  return msg;
}

module.exports = {
  render, text, sep, gap, gallery, section, container, noticeContainer, pagesImage, bar, COLOR_OK, COLOR_ERR,
};
