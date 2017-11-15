# clockin

Time tracking for lively.next. Clock in, clock out, list logged sessions.

## Install

Put this into your local config:

```js
import { World } from "lively.morphic";
lively.modules.registerPackage("clockin").then(async () => {
  let {installInWorld} = await System.import("clockin/ui.js");
  let world = await promise.waitFor(() => World.defaultWorld());
  installInWorld(world);
}).catch(err => console.error(`Error loading clockin ${err.stack}`));
```

# License

[MIT](LICENSE)
