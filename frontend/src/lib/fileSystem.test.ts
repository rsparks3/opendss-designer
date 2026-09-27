import { describe, expect, it } from 'vitest'
import {
  canSaveInPlace,
  pickProjectFile,
  pickSaveTarget,
  projectFileName,
  writeTo,
  type FileHandle,
  type Pickers,
} from './fileSystem'

function fakeHandle(name: string, permission: PermissionState = 'granted', grant: PermissionState = 'granted') {
  const written: string[] = []
  const handle: FileHandle = {
    name,
    getFile: async () => new File(['{}'], name),
    createWritable: async () => {
      let buf = ''
      return {
        write: async (d) => {
          buf += String(d)
        },
        close: async () => {
          written.push(buf)
        },
      }
    },
    queryPermission: async () => permission,
    requestPermission: async () => grant,
  }
  return { handle, written }
}

const abort = () => Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' })

describe('file system access', () => {
  it('is only offered where both pickers exist', () => {
    expect(canSaveInPlace({})).toBe(false)
    expect(canSaveInPlace({ showSaveFilePicker: async () => fakeHandle('a').handle })).toBe(false)
    expect(
      canSaveInPlace({
        showSaveFilePicker: async () => fakeHandle('a').handle,
        showOpenFilePicker: async () => [fakeHandle('a').handle],
      }),
    ).toBe(true)
  })

  it('treats a dismissed picker as nothing chosen, not an error', async () => {
    const p: Pickers = {
      showOpenFilePicker: async () => {
        throw abort()
      },
      showSaveFilePicker: async () => {
        throw abort()
      },
    }
    expect(await pickProjectFile(p)).toBeNull()
    expect(await pickSaveTarget('x', p)).toBeNull()
  })

  it('passes other picker failures on', async () => {
    const p: Pickers = {
      showSaveFilePicker: async () => {
        throw new Error('SecurityError')
      },
    }
    await expect(pickSaveTarget('x', p)).rejects.toThrow('SecurityError')
  })

  it('suggests a project file name and returns the opened file with its handle', async () => {
    let suggested: string | undefined
    const { handle } = fakeHandle('feeder.oneline.json')
    const p: Pickers = {
      showSaveFilePicker: async (o) => {
        suggested = o?.suggestedName
        return handle
      },
      showOpenFilePicker: async () => [handle],
    }
    await pickSaveTarget('feeder.oneline.json', p)
    expect(suggested).toBe('feeder.oneline.json')
    const opened = await pickProjectFile(p)
    expect(opened?.handle).toBe(handle)
    expect(await opened?.file.text()).toBe('{}')
  })

  it('writes the whole text in one go', async () => {
    const { handle, written } = fakeHandle('a.json')
    await writeTo(handle, '{"a":1}')
    expect(written).toEqual(['{"a":1}'])
  })

  it('asks for write permission on a handle that only has read, and stops if refused', async () => {
    const granted = fakeHandle('a.json', 'prompt', 'granted')
    await writeTo(granted.handle, 'x')
    expect(granted.written).toEqual(['x'])
    const refused = fakeHandle('a.json', 'prompt', 'denied')
    await expect(writeTo(refused.handle, 'x')).rejects.toThrow('permission to write a.json')
    expect(refused.written).toEqual([])
  })

  it('names files after the circuit, safely', () => {
    expect(projectFileName('feeder 12')).toBe('feeder 12.oneline.json')
    expect(projectFileName('  ')).toBe('circuit.oneline.json')
    expect(projectFileName('a/b:c')).toBe('a-b-c.oneline.json')
    expect(projectFileName('x.oneline.json')).toBe('x.oneline.json')
  })
})
