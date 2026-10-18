const fs=require('node:fs')
const path=require('node:path')
function stateFile(file) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(file,'utf8')) }
      catch(error) { if(error.code==='ENOENT') return null; throw new Error('desktop_state_unreadable') }
    },
    save(value) {
      fs.mkdirSync(path.dirname(file),{recursive:true})
      const temp=file+'.tmp'
      let fd
      try {
        fd=fs.openSync(temp,'w',0o600); fs.writeFileSync(fd,JSON.stringify(value)); fs.fsyncSync(fd); fs.closeSync(fd);fd=undefined
        fs.renameSync(temp,file)
      } finally { if(fd!==undefined) fs.closeSync(fd); try {fs.unlinkSync(temp)}catch{} }
    }
  }
}
module.exports={stateFile}
