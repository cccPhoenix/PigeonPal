import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {existsSync, readdirSync, rmSync, mkdtempSync, writeFileSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const require=createRequire(import.meta.url)
const {selfCheckSetup}=require('../desktop/self-check.cjs')

test('normal launch never enables diagnostics or creates disposable storage',()=>{
 assert.equal(selfCheckSetup(['app']),null)
 assert.equal(selfCheckSetup(['app','--self-check=false']),null)
 assert.equal(selfCheckSetup(['app','--self-check-hold']),null)
})
test('self-check always allocates empty temporary storage and ignores caller data overrides',()=>{
 const existing=mkdtempSync(join(tmpdir(),'pigeonpal-existing-'))
 writeFileSync(join(existing,'keep'),'existing user data')
 let check
 try {
  check=selfCheckSetup(['app','--self-check',`--user-data-dir=${existing}`])
  assert.notEqual(check.userData,existing)
  assert.deepEqual(readdirSync(check.userData),[])
  assert.equal(existsSync(check.report),false)
  assert.equal(readFileSync(join(existing,'keep'),'utf8'),'existing user data')
 } finally {if(check)rmSync(check.userData,{recursive:true,force:true});rmSync(existing,{recursive:true})}
})
