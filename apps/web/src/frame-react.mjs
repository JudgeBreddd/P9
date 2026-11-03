// The artifact frame's React runtime (scripts/frame-runtimes.mjs bundles this into dist/frame/react.js): React and ReactDOM
// as globals, for a React artifact's code once TypeScript has turned its JSX into React.createElement calls.
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';

globalThis.React = React;
globalThis.ReactDOM = { ...ReactDOM, ...ReactDOMClient };
