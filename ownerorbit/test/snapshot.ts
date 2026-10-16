import { writeFileSync } from 'node:fs'
import { SandboxSession } from '../src/browser/session.ts'

/** Dump the live sandbox state to a fixture for offline parser tests. */
const s = new SandboxSession({ profileDir: '.data/fixture-profile' })
const t = Date.now()
await s.start()
const snap = await s.readTruth()
writeFileSync('test/fixtures/snapshot.json', JSON.stringify(snap, null, 1))
console.log(`api=${s.apiMode} mode=${snap.mode} items=${snap.items.length} cats=${snap.categories.length} groups=${snap.modifierGroups.length} orders=${snap.orders.length} in ${Date.now() - t}ms`)
await s.close()
