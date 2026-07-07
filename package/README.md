# liquidGL

Ultra-light glassmorphism for the web.

## Install

```sh
npm install liquidgl
```

## Usage

```js
import liquidGL from "liquidgl";

const glass = liquidGL({
  target: ".liquidGL",
  snapshot: "body",
});
```

## Required dependency

`html2canvas` is installed automatically as a package dependency.

## Optional 3D model support

`three` is optional and only required when using liquidGL with 3D model workflows.

```sh
npm install three
```

## Helpers

```js
liquidGL.registerDynamic(elements);
liquidGL.syncWith(config);
```

## Browser support

liquidGL requires a browser environment with WebGL support.

## License

MIT
