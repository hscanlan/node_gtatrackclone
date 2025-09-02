// classes/MenuScript.js
export default class MenuScript {
  constructor(modelNumber, modelName, menuCommands) {
    this.modelNumber = modelNumber;
    this.modelName = modelName;
    // Expect an array like: [{ enter: Cmd[] }, { exit: Cmd[] }]
    this.menuCommands = menuCommands || [];
  }

  get enter() {
    const blk = this.menuCommands.find(b => b.enter);
    return blk?.enter ?? [];
  }

  get exit() {
    const blk = this.menuCommands.find(b => b.exit);
    return blk?.exit ?? [];
  }
}
