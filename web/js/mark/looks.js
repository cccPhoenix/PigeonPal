// Looks: what the mark draws. Each look returns SVG markup in a 100×100 box and
// follows the part contract in docs/avatar.md, so every look gets the same motion:
//   .mk-shadow  ground shadow (outside the body, shrinks on hops)
//   .mk-body    everything that moves together
//   .mk-wing-l / .mk-wing-r   optional, flap on alerts
//   .mk-eyes    stationary eye group
//   .mk-pupils  pupils only, follows the pointer
//   .mk-eye     each open eye (blinks)
//   .mk-happy   closed happy eyes, shown while petted
// A look can also be a plain image (see `image` in mark/index.js), which only bobs.

import { REFERENCE_LOOKS } from './reference-looks.js'

const shadow = '<ellipse class="mk-shadow" cx="50" cy="94" rx="22" ry="3.2"/>'

export const LOOKS = {
  // Deliberately blank: a neutral blob that holds the slot until the real character lands.
  placeholder: {
    label: '占位',
    note: '留空的形象槽，等正式形象替换',
    svg: () => `${shadow}
<g class="mk-body">
  <path d="M50 14c21 0 36 15 36 37 0 23-15 38-36 38S14 74 14 51c0-22 15-37 36-37Z" fill="var(--mk-placeholder)"/>
  <g class="mk-eyes">
    <g class="mk-pupils">
    <ellipse class="mk-eye" cx="40" cy="48" rx="4.4" ry="7"/>
    <ellipse class="mk-eye" cx="60" cy="48" rx="4.4" ry="7"/>
    </g>
    <path class="mk-happy" d="M35 50q5-6 10 0M55 50q5-6 10 0"/>
  </g>
</g>`,
  },

  // Sketch A: a round pigeon facing you. Two eyes make blinking and gaze read well at 36px.
  pigeon: {
    label: '团子鸽',
    note: '正面圆团，两只眼睛，表情最清楚',
    svg: () => `${shadow}
<g class="mk-body">
  <g class="mk-wing-l"><path d="M24 50c-9 4-14 14-11 25 8-1 15-6 18-14Z" fill="#4f5fe0"/></g>
  <g class="mk-wing-r"><path d="M76 50c9 4 14 14 11 25-8-1-15-6-18-14Z" fill="#4f5fe0"/></g>
  <path d="M51 14c-2-6 2-10 8-8-3 2-3 5-2 9Z" fill="#6476ff"/>
  <path d="M50 13c20 0 33 17 33 40 0 22-14 36-33 36S17 75 17 53c0-23 13-40 33-40Z" fill="#6476ff"/>
  <g class="mk-eyes">
    <g class="mk-pupils">
    <ellipse class="mk-eye" cx="39.5" cy="44" rx="4.2" ry="6.6"/>
    <ellipse class="mk-eye" cx="60.5" cy="44" rx="4.2" ry="6.6"/>
    </g>
    <path class="mk-happy" d="M35 46q4.5-5.5 9 0M56 46q4.5-5.5 9 0"/>
  </g>
  <ellipse cx="30.5" cy="54" rx="5" ry="3" fill="var(--mk-cheek)" fill-opacity=".5"/>
  <ellipse cx="69.5" cy="54" rx="5" ry="3" fill="var(--mk-cheek)" fill-opacity=".5"/>
  <path d="M45.5 52.5c3-2.4 6-2.4 9 0-1.6 3.2-3 4.8-4.5 4.8s-2.9-1.6-4.5-4.8Z" fill="#ffb53d"/>
</g>`,
  },

  // Sketch B: a side-on messenger pigeon. More "bird", one eye, iridescent neck.
  courier: {
    label: '信鸽',
    note: '侧身信鸽，更像鸟，脖子带一点虹彩',
    svg: () => `${shadow}
<g class="mk-body">
  <path d="M30 60 9 70c-2 6 1 10 7 9l20-6Z" fill="#4b5bd8"/>
  <path d="M19 63c0-17 15-27 33-26 17 1 29 13 27 29-2 15-16 23-33 22-16-1-27-10-27-25Z" fill="#6476ff"/>
  <circle cx="63" cy="33" r="17" fill="#6476ff"/>
  <path d="M49 44c6 7 18 9 28 2l1 7c-10 7-23 6-30-2Z" fill="#53e0c4" fill-opacity=".55"/>
  <g class="mk-wing-l"><path d="M27 60c9-10 27-11 38-1-6 13-23 18-37 12Z" fill="#4b5bd8"/></g>
  <path d="m78 30 9 3.2c1 .4 1 1.6 0 2L78 38Z" fill="#ffb53d"/>
  <ellipse cx="72" cy="41" rx="4" ry="2.4" fill="var(--mk-cheek)" fill-opacity=".55"/>
  <g class="mk-eyes">
    <g class="mk-pupils">
    <ellipse class="mk-eye" cx="68" cy="29.5" rx="3.6" ry="5.6"/>
    </g>
    <path class="mk-happy" d="M64 31q4-5 8 0"/>
  </g>
</g>`,
  },
}

Object.assign(LOOKS, REFERENCE_LOOKS)

export const LOOK_IDS = Object.keys(LOOKS)
export const hasLook = id => typeof id === 'string' && Object.hasOwn(LOOKS, id)

// For the designer's own character: registerLook('mine', { label, svg: () => '...' }).
export function registerLook(id, look) {
  if (!/^[a-z][\w-]{0,31}$/.test(id)) throw new Error('Look ids are lowercase words')
  if (typeof look?.svg !== 'function') throw new Error('A look needs svg() returning markup')
  LOOKS[id] = { label: look.label ?? id, note: look.note ?? '', svg: look.svg }
  if (!LOOK_IDS.includes(id)) LOOK_IDS.push(id)
}
