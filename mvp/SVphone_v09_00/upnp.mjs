/**
 * Minimal UPnP IGD client for port forwarding (no dependencies).
 * Discovers the router via SSDP and uses SOAP to add/remove UDP port mappings.
 */
import dgram from 'node:dgram'
import http from 'node:http'

const SSDP_ADDR = '239.255.255.250'
const SSDP_PORT = 1900
const SEARCH_TARGET = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1'

let cachedControlUrl = null
let cachedServiceType = null

/** Discover the router's IGD control URL via SSDP. */
async function discover() {
  const searchMsg = [
    'M-SEARCH * HTTP/1.1',
    `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    'MX: 3',
    `ST: ${SEARCH_TARGET}`,
    '', '',
  ].join('\r\n')

  const location = await new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4')
    const timer = setTimeout(() => { sock.close(); reject(new Error('UPnP discovery timeout (5s)')) }, 5000)
    sock.on('message', (msg) => {
      const loc = msg.toString().match(/LOCATION:\s*(.+)/i)?.[1]?.trim()
      if (loc) { clearTimeout(timer); sock.close(); resolve(loc) }
    })
    sock.send(searchMsg, SSDP_PORT, SSDP_ADDR)
  })

  // Fetch device description XML
  const desc = await httpGet(location)

  // Find WANIPConnection or WANPPPConnection service
  const re = /<serviceType>(urn:schemas-upnp-org:service:WAN(?:IP|PPP)Connection:\d)<\/serviceType>[\s\S]*?<controlURL>([^<]+)<\/controlURL>/
  const m = desc.match(re)
  if (!m) throw new Error('WANIPConnection service not found in IGD description')

  const base = new URL(location)
  cachedServiceType = m[1]
  cachedControlUrl = new URL(m[2], base).toString()
  console.log(`[UPnP] Discovered gateway: ${cachedControlUrl}`)
  return cachedControlUrl
}

/** Add a UDP port mapping on the router. */
export async function addPortMapping(externalPort, internalPort, internalIp, ttl = 300) {
  if (!cachedControlUrl) await discover()
  const soap = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:AddPortMapping xmlns:u="${cachedServiceType}">
  <NewRemoteHost></NewRemoteHost>
  <NewExternalPort>${externalPort}</NewExternalPort>
  <NewProtocol>UDP</NewProtocol>
  <NewInternalPort>${internalPort}</NewInternalPort>
  <NewInternalClient>${internalIp}</NewInternalClient>
  <NewEnabled>1</NewEnabled>
  <NewPortMappingDescription>SVphone</NewPortMappingDescription>
  <NewLeaseDuration>${ttl}</NewLeaseDuration>
</u:AddPortMapping>
</s:Body>
</s:Envelope>`
  const res = await soapRequest('AddPortMapping', soap)
  if (res.status >= 300) throw new Error(`AddPortMapping failed: ${res.status} ${res.body.slice(0, 200)}`)
  console.log(`[UPnP] Forwarded UDP ${externalPort} → ${internalIp}:${internalPort} (ttl=${ttl}s)`)
}

/** Remove a UDP port mapping. */
export async function deletePortMapping(externalPort) {
  if (!cachedControlUrl) await discover()
  const soap = `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body>
<u:DeletePortMapping xmlns:u="${cachedServiceType}">
  <NewRemoteHost></NewRemoteHost>
  <NewExternalPort>${externalPort}</NewExternalPort>
  <NewProtocol>UDP</NewProtocol>
</u:DeletePortMapping>
</s:Body>
</s:Envelope>`
  const res = await soapRequest('DeletePortMapping', soap)
  console.log(`[UPnP] Removed UDP ${externalPort} (status=${res.status})`)
}

async function soapRequest(action, body) {
  const url = new URL(cachedControlUrl)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'SOAPAction': `"${cachedServiceType}#${action}"`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', (c) => data += c)
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}
