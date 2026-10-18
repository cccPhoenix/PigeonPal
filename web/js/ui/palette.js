// Accent hue follows the chosen companion. Saturation and lightness stay in CSS,
// where both light and dark themes can keep text readable.
const LOOK_HUES = {
  placeholder: 210, pigeon: 230, courier: 230,
  character0: 12, character1: 208, character2: 30, character3: 195,
  character4: 38, character5: 175, character6: 196, character7: 150,
  character8: 275, character9: 332,
}

export const lookHue = look => LOOK_HUES[look] ?? 210

export function dominantHue(pixels) {
  let x = 0, y = 0, weightSum = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const alpha = pixels[i + 3] / 255
    if (alpha < .4) continue
    const r = pixels[i] / 255, g = pixels[i + 1] / 255, b = pixels[i + 2] / 255
    const hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo
    if (hi < .18 || delta < .12) continue
    const saturation = hi ? delta / hi : 0
    if (saturation < .2) continue
    const hue = hi === r ? ((g - b) / delta) % 6 : hi === g ? (b - r) / delta + 2 : (r - g) / delta + 4
    const radians = hue * Math.PI / 3
    const weight = alpha * saturation * (1 - Math.abs(hi - .62) * .5)
    x += Math.cos(radians) * weight
    y += Math.sin(radians) * weight
    weightSum += weight
  }
  if (weightSum < .1 || Math.hypot(x, y) / weightSum < .15) return null
  return Math.round((Math.atan2(y, x) * 180 / Math.PI + 360) % 360)
}

export function imageHue(src) {
  return new Promise(resolve => {
    const image = new Image()
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 32
        const context = canvas.getContext('2d', { willReadFrequently: true })
        context.drawImage(image, 0, 0, 32, 32)
        resolve(dominantHue(context.getImageData(0, 0, 32, 32).data))
      } catch { resolve(null) }
    }
    image.onerror = () => resolve(null)
    image.src = src
  })
}
