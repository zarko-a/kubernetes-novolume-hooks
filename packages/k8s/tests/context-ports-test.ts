import { containerPorts } from '../src/k8s'
import { contextPorts } from '../src/hooks/prepare-job'

// Ported with upstream cc83f88 (#445): the job container's ports in the prepare_job
// response were always empty.
describe('context ports', () => {
  it.each([
    { mappings: undefined, expected: {} },
    { mappings: [], expected: {} },
    { mappings: ['8080'], expected: {} },
    { mappings: ['31080:8080'], expected: { '8080': '31080' } },
    {
      mappings: ['31080:8080', '31081:8081/udp', '9090'],
      expected: { '8080': '31080', '8081': '31081' }
    }
  ])('maps host ports for $mappings', ({ mappings, expected }) => {
    const ports = containerPorts({
      image: 'ubuntu',
      portMappings: mappings
    } as Parameters<typeof containerPorts>[0])
    expect(contextPorts({ name: 'job', ports })).toEqual(expected)
  })

  it('has no ports for a container without any', () => {
    expect(contextPorts({ name: 'job' })).toEqual({})
  })
})
