// Hand-drawn, layered adaptations of images/character0.png … character9.png.
// Keep silhouettes and signature clothing readable at chat-avatar sizes.
// Every part uses the same motion contract as the original pigeon looks.

const shadow = '<ellipse class="mk-shadow" cx="50" cy="95" rx="23" ry="2.8"/>'
const body = (ink, art) => `${shadow}<g class="mk-body" style="--mk-ink:${ink}" stroke="${ink}" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round">${art}</g>`
const feet = (ink, y = 86) => `<path d="M43 ${y}v7m0 0-8 2m8-2 5 2M61 ${y}v7m0 0-6 2m6-2 7 2" fill="none" stroke="${ink}" stroke-width="1.8"/>`
// Whites stay fixed. Only pupils translate; the full eye still scales for a blink.
// Gaze distance follows each eye's size so tiny eyes cannot look outside the socket.
const eye = (x, y, rx = 4, ry = 5, sleepy = false) => `<g class="mk-eye">
${sleepy
    ? `<path class="mk-sclera" d="M${x-rx} ${y}a${rx} ${ry} 0 0 0 ${rx*2} 0Z" fill="#fffdf7"/>`
    : `<ellipse class="mk-sclera" cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="#fffdf7"/>`}
<g class="mk-pupils" style="--mk-gaze-x:${rx*.2}px;--mk-gaze-y:${ry*(sleepy ? .08 : .18)}px">
  <ellipse cx="${x}" cy="${sleepy ? y+ry*.48 : y}" rx="${rx*(sleepy ? .28 : .43)}" ry="${ry*(sleepy ? .27 : .51)}" fill="var(--mk-ink)" stroke="none"/>
</g>
</g>`
const eyes = (points, sleepy = false) => `<g class="mk-eyes">${points.map(([x,y,rx,ry]) => eye(x,y,rx,ry,sleepy)).join('')}<path class="mk-happy" stroke-width="1.6" d="${points.map(([x,y]) => `M${x-3} ${y+1}q3-4 6 0`).join(' ')}"/></g>`
const bow = (x,y,color) => `<g fill="${color}"><path d="M${x-1} ${y}q-11-8-10-2l1 7q1 3 9-2m2-3q11-8 10-2l-1 7q-1 3-9-2"/><rect x="${x-2}" y="${y-1}" width="4" height="6" rx="2"/></g>`

export const REFERENCE_LOOKS = {
  character0: {
    label: '红心鸽', note: '红羽毛 · 黄领结', reference: 'character0.png',
    svg: () => body('#252438', `
<path d="M69 49q8-24 17-13 8-10 9 2 10 10-5 24Z" fill="#fffdf7"/>
<path d="M26 68 28 88h9V70m16 1 2 17h9V71" fill="#fffdf7"/>
<path d="M24 88q-6-5-9 1l2 5h22v-6m15 0q-7-4-9 2l1 4h21v-6" fill="#f27658"/>
<path d="M26 25q-13-11-7-18 7-8 13 6 6-12 11-4l1 13 14 2-2 20q4 13 24 15 12-3 10 5-12 18-39 19-27 0-33-18-4-10 5-22l-1-12Z" fill="#f27658"/>
<path d="M21 48q4 28 31 14-5 22-20 14-14-6-11-28" fill="#fffdf7"/>
<g class="mk-wing-l"><path d="M56 46q7-16 18-7 7 17 17 20-12 13-27 3-9-7-8-16Z" fill="#edbf56"/><path d="M72 42q0 15 14 18-13 2-20-5" fill="#fffdf7"/></g>
${eyes([[27,32,6.4,7],[48,30,6.4,7]],true)}
<path d="M33 38q5-8 12 0-4 6-14 6Z" fill="#efc861"/><path d="m33 39 10-1" fill="none"/>
${bow(37,51,'#f5d876')}
<path d="M70 18q-5-14 1-14 4 0 5 5 7-2 6 4-3 5-12 5Z" fill="#f27658"/>
`),
  },
  character1: {
    label: '派对鸽', note: '蓝色尖帽 · 好奇眼神', reference: 'character1.png',
    svg: () => body('#294c70', `
<path d="M43 79v10m14-9 2 9" fill="none" stroke-width="3"/>
<path d="M40 89q6-7 10 0 7-4 8 5H38Zm18 0q6-7 10 0 7-4 8 5H56Z" fill="#86b0dc"/>
<path d="m42 23-14-18 24 13" fill="#83afdb"/><path d="m34 8-2 5m9 0-4 6m-9-14-7 1m7-1-2-5m2 5 5-5" fill="none"/>
<path d="M43 23q7-13 18-8 28 14 21 45-3 25-28 26Q28 82 8 68q18 1 30-10 20-9 7-23Z" fill="#6699c2"/>
<path d="M8 68q22 3 40-6l4 15q-21 4-44-9Z" fill="#8cb5df"/><path d="M18 73q13 3 26-2" fill="none"/>
<path d="M55 26q16 13 23 34l-7-1-4 5-7-4-5 3-9-5q20-16 9-32Z" fill="#8bb2df"/>
<g class="mk-wing-l"><path d="M49 57q17-2 17 13-1 11-16 12-7-4-8-11Z" fill="#284a76"/><path d="m47 58 3 5-3 3 5 3-2 3 5 5-6 5q-13-5-7-16Z" fill="#6699c2"/></g>
<path d="M48 34q-6-3-7 5l5 2 4-3Z" fill="#dceafa"/>
${eyes([[55,20,6.5,7],[39,34,6,6.5]])}
`),
  },
  character2: {
    label: '侦探鸽', note: '棕色礼帽 · 圆框眼镜', reference: 'character2.png',
    svg: () => body('#896045', `
${feet('#896045')}
<path d="M27 29q-7 17-5 34Q8 68 23 80q19 13 39 5 12-6 26-3l-8-8q-14-4-16-25-1-15-11-20Z" fill="#fffdf3"/>
<path d="M24 53q-8 4-6 18 5 17 27 17l37-10q-26 0-31-17-9-13-27-8Z" fill="#d6ac75"/>
<g class="mk-wing-l"><path d="M60 52q11-8 23 6l10 3-7 5 10 1-9 7 9-1q-19 15-35 4-13-12-1-25Z" fill="#916548"/><path d="M62 61q3 5 6 1 3 4 6 0m-13 10q3 5 6 1 4 5 8-1" fill="none" stroke="#b89460" stroke-width="2.5"/></g>
<path d="M26 59q2 4 5 0m5 0q3 4 5 0M24 67q3 4 6 0m6 0q3 4 6 0M28 75q3 4 6 0m6 0q3 4 6 0" fill="none" stroke-width="2"/>
<path d="M31 18 38 5q11-8 25 5l-2 15Z" fill="#916548" stroke="none"/>
<path d="m32 16 30 7-2 4-30-7" fill="#fffdf3" stroke="none"/>
<path d="M19 18q16-9 43 5 14 8 7 10-12 0-28-9-28-4-22-6Z" fill="#ac8959" stroke="none"/>
${eyes([[30,33,6.5,7.5],[49,36,6.5,7.5]])}
<path d="M36 33q3-3 7 1m-21-3-2-1m36 7 3 1" fill="none" stroke="#ac8959" stroke-width="2.1"/>
<path d="m35 41-3 7 10-4q-1-7-7-3Z" fill="#e5c38c"/>
`),
  },
  character3: {
    label: '礼帽鸽', note: '蓝紫领结 · 高顶礼帽', reference: 'character3.png',
    svg: () => body('#082c57', `
${feet('#082c57')}
<path d="M29 25q-7 8-8 30Q7 74 32 84q21 9 44-2l17-8-17-7q-23-9-21-43Z" fill="#0e98bf"/>
<path d="M21 53q20 9 38-8 0 16 18 23l-2 14q-23 14-47 0-16-8-7-29Z" fill="#e4f4fc"/>
<path d="M76 64q9 6 18 5l-8 5 7 4-15 2Z" fill="#2873b9"/>
<g class="mk-wing-l"><path d="M60 50q10-1 17 14l10 12q-18 7-30-7-9-13 3-19Z" fill="#0c99c2"/><path d="m70 71 5 3 5-1 5 4" fill="#2873b9"/></g>
<path d="M28 66q2 4 5 0m5 0q2 4 5 0m-12 7q2 4 5 0m5 0q2 4 5 0" fill="none" stroke="#9bd5e8" stroke-width="1.6"/>
<path d="m28 24 1-20q11-4 24 0l-2 21" fill="#062c58"/>
<path d="m28 19 24 1v5H28Z" fill="#2873b9" stroke="none"/>
<path d="M21 23q16 7 37 1" fill="none" stroke-width="4"/>
${eyes([[30,34,2.1,3.7],[43,35,2.1,3.7]])}
<path d="m32 40 7-2-2 5h-6Z" fill="#b7ddec"/>
${bow(32,52,'#2873b9')}
`),
  },
  character4: {
    label: '法棍鸽', note: '贝雷帽 · 抱着面包', reference: 'character4.png',
    svg: () => body('#795627', `
${feet('#795627',85)}
<g class="mk-wing-r"><path d="M65 46q13-10 4-31 13 5 15 17l5-13q11 19 1 30l7-3q-5 16-24 14Z" fill="#deb274"/></g>
<path d="M44 20q10-7 17 9l5 19q15 13 7 27-6 9-15 14l-8-4q-20 0-25-16-4-13 14-24Z" fill="#e6bd80"/>
<path d="m34 25 5-15 13-8-1 6 4 3q-5 11-21 14Z" fill="#795627"/>
<path d="m35 57-10-14q-7-10-10-4-1 3 4 9l28 33q5 5 8 0 2-3-2-8Z" fill="#785022"/>
<path d="m22 43 3 5m5 4 3 5m7 7 3 5m5 5 2 4" stroke="#f3cc8b" stroke-width="2"/>
<g class="mk-wing-l"><path d="M44 50q-9-9-16 7L11 49l3 12-12-6 1 16 17-1-13 11 17-3-6 11q18-2 24-16 15-11 2-23Z" fill="#ecc48a"/><path d="m25 73 6-8m2 13 5-9" fill="none"/></g>
${eyes([[45,32,3.8,5.7],[55,24,3.8,5.7]])}
<path d="M49 34q7-6 9-2l-1 5-7 1Z" fill="#bc8d4f"/>
`),
  },
  character5: {
    label: '围巾鸽', note: '薄荷绿 · 暖棕围巾', reference: 'character5.png',
    svg: () => body('#075359', `
${feet('#a28559')}
<path d="M23 26q17-15 31 0l5 29q7 7 27 17l9 10-26-4 24 10-17 1-12-8q-29 10-46-6-15-14 0-33Z" fill="#0fbabd" stroke="none"/>
<path d="M19 47q9 6 30 4 2 24 25 28-24 13-47 3-20-9-14-29Z" fill="#8bd7d0" stroke="none"/>
<g class="mk-wing-l"><path d="M53 50q11 0 21 17l18 11q-24 6-37-5-13-11-2-23Z" fill="#0bbabe" stroke="none"/><path d="M55 72q5 2 7-2 6 3 7-3 6 1 6-4l4 6 13 9q-27 4-37-6Z" fill="#039194" stroke="none"/></g>
<path d="M25 21q0-16 16-17 17 0 18 18" fill="#ad8b5b" stroke="none"/>
<path d="m25 14 34 2v5l-35-2" fill="#064f53" stroke="none"/>
<path d="M17 20q1-8 28-1 27 3 23 10-2 5-24-2-31-2-27-7Z" fill="#ad8b5b" stroke="none"/>
<path d="M18 48q21 8 41-1l3 7q-21 10-45 2Z" fill="#ae8b59" stroke="none"/>
<path d="m23 51-3 5m11-3-2 5m12-4-1 5m13-6v4" stroke="#80653f" stroke-width="3"/>
<path d="m28 55-3 18 6 1 3-18m4-1 2 18 6-1-3-18" fill="#ae8b59" stroke="none"/>
<path d="m26 65 6 1m-7 5 6 1m9-8 5-1m-4 6 5-1" stroke="#80653f" stroke-width="2"/>
${eyes([[25,34,5.5,6],[43,35,6.2,6.5]])}
<path d="M30 34q4-3 7 0m12 1 10-1m-40 0h-2" fill="none" stroke-width="2"/>
<path d="M23 40q4-5 10 0-2 4-11 2Z" fill="#ad8b5b"/>
`),
  },
  character6: {
    label: '冰蓝绅士', note: '白色西装 · 蓝顶帽', reference: 'character6.png',
    svg: () => body('#2a3f65', `
${feet('#2a3f65')}
<path d="M36 25q15-7 24 4l4 21q9 5 14 17l15 11q-14 8-29-4l-10 13q-10-5-15-13-14 13-29 5l13-13q3-12 10-16Z" fill="#d4f0f7"/>
<path d="M21 73q9-1 16-9m-20 13q13-1 20-8" fill="none" stroke="#6dabc4"/>
<path d="M35 48q13 4 29-4l1 7-20 8-7-5-5 4Z" fill="#fffefa"/>
<path d="M37 54q-8 8-5 20l9 4 2-20m3 0-1 20 13-2 7-20" fill="#b5dce9"/>
<path d="m40 61-1 11" fill="none" stroke="#fffefa" stroke-width="2.5"/>
<circle cx="38" cy="62" r="1" fill="#079cca" stroke="none"/><circle cx="38" cy="67" r="1" fill="#079cca" stroke="none"/>
<g class="mk-wing-l"><path d="M62 52q18-5 20 18l11 8q-18 11-34-4-9-14 3-22Z" fill="#d4f0f7"/><path d="M79 70q1 8 12 10m-16-7q0 7 9 10m-13-8q0 6 6 9" fill="none" stroke="#6dabc4"/><path d="M63 58q-10 12 4 17" fill="none" stroke="#fffefa" stroke-width="2"/></g>
<ellipse cx="48" cy="24" rx="20" ry="4.5" fill="#009ccb"/>
<path d="m34 24-1-17q13-6 27 0l-2 17Z" fill="#039dcc"/><path d="m35 19 23 1" fill="none" stroke="#fffefa" stroke-width="3"/>
<path d="m57 33 2 10" fill="none" stroke="#fffefa" stroke-width="2"/>
${eyes([[45,33,3.9,4.6]])}
<path d="M37 34q-10-3-12 5l12 1q4-2 0-6Z" fill="#9ed5e5"/><path d="m26 38 11-1" fill="none"/>
`),
  },
  character7: {
    label: '森系旅人', note: '叶子贝雷帽 · 奶油马甲', reference: 'character7.png',
    svg: () => body('#2b4852', `
<path d="m43 77-2 12-7 4q-3 5 9 1l6 1-1-3 3-11m10-4 1 12 7 3q8 5-2 3l-7-2-6 2-2-3 3-12" fill="#cdb7a6"/>
<path d="M29 60 13 78q8 4 20-4l-3 8q12-1 17-12Z" fill="#f6fbf9"/>
<path d="M37 57q-15 21 4 29l8-3 5 4q12-4 13-21Z" fill="#98b8bd"/>
<path d="M33 40q-12 10-11 29l17 7 3-22m17-11q15 8 18 25l-13 6-8-22" fill="#d9c2af"/>
<path d="M37 47q13 10 26 0l-2 27q-13 5-21-1Z" fill="#f7fcfa"/>
<path d="M36 47q14 10 28 0l-1 6q-13 7-26-1Z" fill="#98b8bd"/>
<g class="mk-wing-l"><path d="M28 47q-8-2-11 9-5 7-14 5-1 5 10 8L7 70q1 5 12 3l-5 5q14 5 20-11l2-14Z" fill="#f7fcfa"/><path d="M18 65q4 2 5-2 3 4 6-1" fill="none"/></g>
<g class="mk-wing-r"><path d="M71 47q9 2 12 11 5 4 14 3 0 6-12 8l9 1q-3 7-14 3l4 5q-11 1-15-13Z" fill="#f7fcfa"/></g>
<path d="M34 19q10-12 26-3 16 11 5 29l-2 8q-18 5-29-11-8-14 0-23Z" fill="#f7fcfa"/>
<path d="M60 32q8-2 13 7l-11-1-7-4Z" fill="#d9c2af"/>
<path d="M28 22q-11-14 15-20 19-3 29 11l-2 6q9 9-7 9 0-8-13-10-13-2-22 4Z" fill="#98b8bd"/>
<path d="M28 22q11-17 31-11 9 2 11 8" fill="none" stroke="#f7fcfa" stroke-width="2"/>
<path d="M28 10q-12-1-14-9 9 1 12 9m-1-1q-5-10 1-9 6 5 2 10" fill="#d8e7df"/>
${eyes([[45,28,4.5,5]])}
<ellipse cx="40" cy="36" rx="3.1" ry="1.8" fill="#e5c5b7" stroke="none"/>
`),
  },
  character8: {
    label: '摇滚鸽', note: '白色羽冠 · 铆钉背心', reference: 'character8.png',
    svg: () => body('#57465e', `
${feet('#57465e')}
<path d="m38 72-5 12 13 1 3-12m6 0-1 12h13l-6-13" fill="#fffdf9"/>
<path d="M29 64 4 51l7 18-9 1 30 3Z" fill="#fffdf9"/>
<g class="mk-wing-r"><path d="M58 38q13 0 21-16l15-6-11 14 15-5q-5 11-17 17l13-1q-11 10-19 8l5 5q-15 6-25-9Z" fill="#fffdf9"/></g>
<g class="mk-wing-l"><path d="M41 37q-11 10-23-2L6 23l15 6L2 19l8 14-8-3q4 13 16 17l-10 1q10 8 26 6Z" fill="#fffdf9"/></g>
<path d="M43 17q-2-8 4-9 7-2 4-7 10 0 8 9l5-4-2 8q5 3 1 14l-6 43q-1 8-14 7H19l18-22Z" fill="#fffdf9"/>
<path d="m39 35-7-2 3-4 11-2-5 15m19-9 9-4-1 6-8 5" fill="#d2ad75"/>
<path d="m40 37-11 21q15 7 18 3 2-7-7-24m19-3 7 26-10 1" fill="#d2ad75"/>
<g fill="#57465e" stroke="none"><circle cx="41" cy="46" r="1.2"/><circle cx="43" cy="51" r="1.2"/><circle cx="44" cy="56" r="1.2"/><circle cx="60" cy="47" r="1.1"/><circle cx="61" cy="52" r="1.1"/><circle cx="62" cy="57" r="1.1"/></g>
${eyes([[46,21,4.1,5.5],[60,23,4.1,5.5]],true)}
<path d="M52 27q-6 1-3 5l6 2Z" fill="#d2ad75"/>
`),
  },
  character9: {
    label: '邮差鸽', note: '莓红帽 · 黄色邮包', reference: 'character9.png',
    svg: () => body('#25253b', `
<path d="M40 79v11h9V78m12 0v12h9V79" fill="#fffdf9"/>
<path d="M38 89q-8-1-8 6h22v-6m7 0-3 6h21q2-5-8-6Z" fill="#ab276b"/>
<path d="M22 59 10 52q-8 1 2 12l-7-1q-5 3 10 11l20-2Z" fill="#fffdf9"/>
<path d="M32 39q-12 20-6 31l9 15h35q16-7 5-27L58 36Z" fill="#efc15c"/>
<path d="m68 58 21-1v22H70Z" fill="#edbd57"/><path d="m70 57 20 1v6H70" fill="#eb7b50"/>
<path d="M38 63q25-5 37 3 8 14-7 20H35Z" fill="#ab276b"/>
<path d="M41 65q14-4 29-2v3q-17-2-29 3Z" fill="#fffdf9"/><path d="M51 64h7v3h-7Z" fill="#25253b"/>
<g class="mk-wing-r"><path d="M61 43q10 0 12-14L67 24l10-1q16 9 15 25-4 11-15 14Z" fill="#fffdf9"/><path d="M73 29q7 3 13 1m-10 6q7 3 14 0m-13 7q6 4 15 0" fill="none"/></g>
<g class="mk-wing-l"><path d="M31 52q-7-3-12 6L7 76q8 4 15-1l-3 5q10 3 20-8l-3 5q13-2 13-12-3-11-18-13Z" fill="#fffdf9"/><path d="m22 75 12-13m5 10 4-8" fill="none"/></g>
<path d="M31 17q6-10 24-9 17 5 12 19L55 43q-5 10-15 3-14-10-9-29Z" fill="#fffdf9"/>
<path d="M30 19 30 9q0-4 23-7l3 8q15-4 17 4-2 8-13 8-4-11-16-7Z" fill="#ab276b"/>
<path d="m31 15 25-8 1 3-26 9Z" fill="#ec7757"/>
${eyes([[40,25,4.2,5.2],[57,27,4.2,5.2]])}
<path d="M37 18q3-3 6 0m10 2q3-2 6 1" fill="none" stroke-width="1.8"/>
<path d="m46 30 5-2 1 6Z" fill="#efc15c"/>
<path d="M27 49q20-8 48 18l-2 3Q44 47 26 53Z" fill="#ab276b"/>
`),
  },
}
