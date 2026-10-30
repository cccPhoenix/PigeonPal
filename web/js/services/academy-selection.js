const ACADEMIES = new Set(['', 'yunfeng', 'danyang', 'lantian'])

export const cleanAcademy = value => ACADEMIES.has(value) ? value : ''
export const academySourceVisible = (sourceId, academy = '') => !cleanAcademy(academy)
  || !sourceId || !ACADEMIES.has(sourceId) || sourceId === academy

// The persistent profile belongs to the local API. Keep only the current UI
// choice in memory, and never let a slow startup read overwrite a later save.
export function createAcademySelection({ client, onChange = () => {} }) {
  let academy = '', version = -1, request = 0
  function apply(snapshot) {
    if (!snapshot || !Number.isSafeInteger(snapshot.version) || snapshot.version < version) return false
    version = snapshot.version
    academy = cleanAcademy(snapshot.academy)
    onChange(academy)
    return true
  }
  async function refresh(snapshot) {
    const turn = ++request
    if (snapshot !== undefined) return apply(snapshot)
    try {
      const value = await client.userProfile()
      return turn === request && apply(value)
    } catch { return false }
  }
  return { refresh, get academy() { return academy } }
}
