# Marble Roulette 3D

A lucky draw app where marbles drop through obstacle courses to determine a winner. Physics and rendering are fully 3D.

[Demo](https://yooseongc.github.io/roulette)

## Features

- 3D physics simulation using Rapier3D (WebAssembly)
- 3D rendering with Three.js (WebGL)
- Multiple maps: Wheel of Fortune, BubblePop, Pot of Greed, Yoru ni Kakeru
- Weighted entries (e.g. `name/2` for 2× chance)
- Multiple entries (e.g. `name*3` for 3 marbles)
- Rank selection (pick 1st, 2nd, … place winner)
- Minimap and live rank display
- Video recording support

## Requirements

- Node.js
- Yarn
- TypeScript
- Parcel
- three
- @dimforge/rapier3d-compat

## Development

```shell
yarn
yarn dev
```

## Build

```shell
yarn build
```
