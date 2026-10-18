const ORIGIN='pigeonpal://app'
function localURL(value) { try {const u=new URL(value);return u.protocol==='pigeonpal:'&&u.hostname==='app'&&!u.port&&!u.username&&!u.password}catch{return false} }
function externalURL(value) { try {const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null}catch{return null} }
function proxyURL(value, backend) {if(!localURL(value)) throw new Error('invalid_origin'); const u=new URL(value);return backend+u.pathname+u.search}
function clipboardAllowed(permission,details) {return permission==='clipboard-sanitized-write'&&details?.isMainFrame===true&&localURL(details.requestingUrl)}
module.exports={ORIGIN,localURL,externalURL,proxyURL,clipboardAllowed}
