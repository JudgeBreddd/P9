// The one place P9 touches the ACP SDK's connection API (0.1.9 O52). chat.mjs and the tests call the method names
// below; the SDK's own classes with these names (ClientSideConnection, AgentSideConnection) were removed in sdk 2.x.
// '/unstable' is the full ACP v1 surface: the SDK's default entry is stable v1 only, without session configOptions,
// elicitation and the prompt reply's usage, all of which P9 reads.
import * as acp from '@agentclientprotocol/sdk/unstable';
import { v1Stream } from './acp-v2.mjs';

export const { ndJsonStream, RequestError, PROTOCOL_VERSION } = acp;

const AGENT = { initialize: 'initialize', newSession: 'session/new', resumeSession: 'session/resume', closeSession: 'session/close',
  setSessionConfigOption: 'session/set_config_option', prompt: 'session/prompt' };

// handlers: { sessionUpdate(params), requestPermission(params), createElicitation(params) }, each given the request's params only.
// The stream goes through acp-v2.mjs: an agent that answers initialize with protocol 2 is translated to v1 there.
export function connectClient(raw, handlers) {
  const stream = v1Stream(raw);
  const connection = acp.client({ name: 'p9' })
    .onNotification('session/update', ({ params }) => handlers.sessionUpdate(params))
    .onRequest('session/request_permission', ({ params }) => handlers.requestPermission(params))
    .onRequest('elicitation/create', ({ params }) => handlers.createElicitation(params))
    .connect(stream);
  const request = (method, params) => connection.agent.request(method, params);
  return { ...Object.fromEntries(Object.entries(AGENT).map(([name, method]) => [name, (params) => request(method, params)])),
    cancel: (params) => connection.agent.notify('session/cancel', params), request, closed: connection.closed, version: stream.version };
}

// The agent side, for test/fake-acp-agent.mjs: handlers by the same names, plus extMethod(method, params) for any other request.
export function connectAgent(stream, handlers) {
  const app = acp.agent({ name: 'p9-fake-agent' });
  for (const [name, method] of Object.entries({ ...AGENT, authenticate: 'authenticate' })) if (handlers[name]) app.onRequest(method, ({ params }) => handlers[name](params));
  if (handlers.cancel) app.onNotification('session/cancel', ({ params }) => handlers.cancel(params));
  if (handlers.extMethod) app.onRequest('*', ({ method, params }) => handlers.extMethod(method, params));
  const connection = app.connect(stream);
  return { sessionUpdate: (params) => connection.client.notify('session/update', params),
    requestPermission: (params) => connection.client.request('session/request_permission', params),
    createElicitation: (params) => connection.client.request('elicitation/create', params), closed: connection.closed };
}
