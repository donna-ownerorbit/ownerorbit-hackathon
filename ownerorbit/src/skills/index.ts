import { z } from 'zod'
import type { Skill } from '../core/types.ts'
import { menuItemSkills } from './menu-items.ts'
import { menuStructureSkills } from './menu-structure.ts'
import { operationsSkills } from './operations.ts'
import { websiteSkills } from './website.ts'

export const SKILLS: Skill[] = [...menuItemSkills, ...menuStructureSkills, ...operationsSkills, ...websiteSkills]

const byId = new Map(SKILLS.map((s) => [s.id, s]))
if (byId.size !== SKILLS.length) throw new Error('duplicate skill id')

export const getSkill = (id: string) => byId.get(id)

/** Tool name for LLMs: dots aren't allowed in tool names. */
export const toolName = (id: string) => id.replace(/\./g, '__')
export const fromToolName = (n: string) => n.replace(/__/g, '.')

export function jsonSchema(s: Skill) {
  const schema = z.toJSONSchema(s.input, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete schema.$schema
  return schema
}
