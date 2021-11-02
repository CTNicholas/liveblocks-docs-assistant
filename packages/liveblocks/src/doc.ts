import { remove } from "./utils";
import {
  CrdtType,
  CreateListOp,
  CreateMapOp,
  CreateObjectOp,
  DeleteObjectKeyOp,
  DeleteCrdtOp,
  Op,
  OpType,
  UpdateObjectOp,
  SerializedCrdtWithId,
  SerializedList,
  SerializedMap,
  SetParentKeyOp,
  CreateRegisterOp,
} from "./live";
import { compare, makePosition, posCodes } from "./position";

type Dispatch = (ops: Op[]) => void;

function noOp() {}

type UndoStackItem = Op[];

const MAX_UNDO_STACK = 50;

type StorageSubscriberCallback = (nodes: AbstractCrdt[]) => void;

type ApplyResult =
  | { reverse: Op[]; modified: AbstractCrdt }
  | { modified: false };

export class Doc<T extends Record<string, any> = Record<string, any>> {
  #clock = 0;
  #opClock = 0;
  #items = new Map<string, AbstractCrdt>();
  #root: LiveObject<T>;
  #actor: number;
  #broadcast: Dispatch;
  #undoStack: UndoStackItem[] = [];
  #redoStack: UndoStackItem[] = [];
  #isBatching: boolean = false;

  #toBatch = {
    ops: [] as Op[],
    modified: new Set<AbstractCrdt>(),
    reverseOps: [] as Op[],
  };

  _subscribers: Array<StorageSubscriberCallback> = [];

  get undoStack() {
    return this.#undoStack;
  }

  constructor(
    root: LiveObject<T>,
    actor: number = 0,
    broadcast: Dispatch = noOp
  ) {
    this.#root = root;
    this.#actor = actor;
    this.#broadcast = broadcast;
  }

  static from<T>(root: T, actor: number = 0, dispatch: Dispatch = noOp) {
    const rootRecord = new LiveObject(root) as LiveObject<T>;
    const storage = new Doc(rootRecord, actor, dispatch) as Doc<T>;
    rootRecord._attach(storage.generateId(), storage);
    storage.dispatch(rootRecord._serialize(), [], []);
    return storage;
  }

  static load<T>(
    items: SerializedCrdtWithId[],
    actor: number,
    dispatch: Dispatch = noOp
  ): Doc<T> {
    if (items.length === 0) {
      throw new Error("Internal error: cannot load storage without items");
    }

    const parentToChildren = new Map<string, SerializedCrdtWithId[]>();
    let root = null;

    for (const tuple of items) {
      const parentId = tuple[1].parentId;
      if (parentId == null) {
        root = tuple;
      } else {
        const children = parentToChildren.get(parentId);
        if (children != null) {
          children.push(tuple);
        } else {
          parentToChildren.set(parentId, [tuple]);
        }
      }
    }

    if (root == null) {
      throw new Error("Root can't be null");
    }

    const doc = new Doc<T>(null as any as LiveObject<T>, actor, dispatch);
    doc.#root = LiveObject._deserialize(
      root,
      parentToChildren,
      doc
    ) as LiveObject<T>;
    return doc;
  }

  #genericSubscribe(callback: StorageSubscriberCallback) {
    this._subscribers.push(callback);
    return () => remove(this._subscribers, callback);
  }

  #crdtSubscribe<T extends AbstractCrdt>(
    crdt: T,
    innerCallback: () => void,
    options?: { isDeep: boolean }
  ) {
    const cb = (nodes: AbstractCrdt[]) => {
      for (const node of nodes) {
        if (node === crdt) {
          innerCallback();
        }
      }
    };

    return this.#genericSubscribe(cb);
  }

  subscribe(
    node: AbstractCrdt,
    callback: () => void,
    options?: { isDeep: boolean }
  ): () => void;
  subscribe(callback: StorageSubscriberCallback): () => void;
  subscribe(
    ...parameters:
      | [
          item: AbstractCrdt,
          callback: () => void,
          options?: { isDeep: boolean }
        ]
      | [StorageSubscriberCallback]
  ): () => void {
    if (parameters[0] instanceof AbstractCrdt) {
      return this.#crdtSubscribe(
        parameters[0] as AbstractCrdt,
        parameters[1] as () => void,
        parameters[2]
      );
    }

    const callback = parameters[0];
    return this.#genericSubscribe(callback);
  }

  addItem(id: string, item: AbstractCrdt) {
    this.#items.set(id, item);
  }

  deleteItem(id: string) {
    this.#items.delete(id);
  }

  getItem(id: string) {
    return this.#items.get(id);
  }

  applyRemoteOperations(ops: Op[]) {
    const applyResults = this.#apply(ops);
    const modified = new Set<AbstractCrdt>();

    for (const applyResult of applyResults) {
      if (applyResult.modified) {
        modified.add(applyResult.modified);
      }
    }

    this.#notify(modified);
  }

  #apply(ops: Op[]): ApplyResult[] {
    const result: ApplyResult[] = [];
    for (const op of ops) {
      result.push(this.#applyOp(op));
    }
    return result;
  }

  #applyOp(op: Op): ApplyResult {
    switch (op.type) {
      case OpType.DeleteObjectKey:
      case OpType.UpdateObject:
      case OpType.DeleteCrdt:
      case OpType.SetParentKey: {
        const item = this.#items.get(op.id);

        if (item == null) {
          return { modified: false };
        }

        return item._apply(op);
      }
      case OpType.CreateList:
      case OpType.CreateObject:
      case OpType.CreateMap:
      case OpType.CreateRegister: {
        const parent = this.#items.get(op.parentId!);
        if (parent == null) {
          return { modified: false };
        }
        return parent._apply(op);
      }
    }

    return { modified: false };
  }

  batch(fn: () => void) {
    if (this.#isBatching) {
      throw new Error("batch should not be called during a batch");
    }

    this.#isBatching = true;

    try {
      fn();
    } finally {
      // If the callback is throwing it's important to set the isBatching flag to false to make sure that future ops are dispatched
      this.#isBatching = false;
      this.#addToUndoStack(this.#toBatch.reverseOps);
      this.#redoStack = [];
      this.#broadcast(this.#toBatch.ops);
      this.#notify(this.#toBatch.modified);
      this.#toBatch = {
        ops: [],
        reverseOps: [],
        modified: new Set(),
      };
    }
  }

  get root(): LiveObject<T> {
    return this.#root;
  }

  dispatch(ops: Op[], reverse: Op[], modified: AbstractCrdt[]) {
    if (this.#isBatching) {
      this.#toBatch.ops.push(...ops);
      for (const item of modified) {
        this.#toBatch.modified.add(item);
      }
      this.#toBatch.reverseOps.push(...reverse);
    } else {
      this.#addToUndoStack(reverse);
      this.#redoStack = [];
      this.#broadcast(ops);
      this.#notify(new Set(modified));
    }
  }

  #notify(modified: Set<AbstractCrdt>) {
    if (modified.size === 0) {
      return;
    }

    for (const subscriber of this._subscribers) {
      subscriber(Array.from(modified));
    }
  }

  #addToUndoStack(ops: Op[]) {
    if (this.#undoStack.length >= MAX_UNDO_STACK) {
      this.#undoStack.shift();
    }
    this.#undoStack.push(ops);
  }

  undo() {
    if (this.#isBatching) {
      throw new Error("undo is not allowed during a batch");
    }

    const ops = this.#undoStack.pop();

    if (ops == null) {
      return;
    }

    const applyResults = this.#apply(ops);

    const reverse: Op[] = [];
    const modified = new Set<AbstractCrdt>();
    for (const applyResult of applyResults) {
      if (applyResult.modified) {
        reverse.push(...applyResult.reverse);
        modified.add(applyResult.modified);
      }
    }

    this.#notify(modified);
    this.#redoStack.push(reverse);
    this.#broadcast(ops);
  }

  redo() {
    if (this.#isBatching) {
      throw new Error("redo is not allowed during a batch");
    }

    const ops = this.#redoStack.pop();

    if (ops == null) {
      return;
    }

    const applyResults = this.#apply(ops);

    const reverse: Op[] = [];
    const modified = new Set<AbstractCrdt>();
    for (const applyResult of applyResults) {
      if (applyResult.modified) {
        reverse.push(...applyResult.reverse);
        modified.add(applyResult.modified);
      }
    }

    this.#notify(modified);
    this.#undoStack.push(reverse);
    this.#broadcast(ops);
  }

  count() {
    return this.#items.size;
  }

  generateId() {
    return `${this.#actor}:${this.#clock++}`;
  }

  generateOpId() {
    return `${this.#actor}:${this.#opClock++}`;
  }
}

abstract class AbstractCrdt {
  #parent?: AbstractCrdt;
  #doc?: Doc;
  #id?: string;
  #parentKey?: string;

  /**
   * INTERNAL
   */
  protected get _doc() {
    return this.#doc;
  }

  /**
   * INTERNAL
   */
  get _id() {
    return this.#id;
  }

  /**
   * INTERNAL
   */
  get _parent() {
    return this.#parent;
  }

  /**
   * INTERNAL
   */
  get _parentKey() {
    return this.#parentKey;
  }

  /**
   * INTERNAL
   */
  _apply(op: Op): ApplyResult {
    switch (op.type) {
      case OpType.DeleteCrdt: {
        if (this._parent != null && this._parentKey != null) {
          const reverse = this._serialize(this._parent._id!, this._parentKey);
          this._parent._detachChild(this);
          return { modified: this, reverse };
        }

        return { modified: false };
      }
      case OpType.CreateObject: {
        return this.#applyCreateObject(op);
      }
      case OpType.CreateMap: {
        return this.#applyCreateMap(op);
      }
      case OpType.CreateRegister: {
        return this.#applyRegister(op);
      }
      case OpType.CreateList: {
        return this.#applyCreateList(op);
      }
      case OpType.SetParentKey: {
        return this.#applySetParentKey(op);
      }
    }

    return { modified: false };
  }

  #applySetParentKey(op: SetParentKeyOp): ApplyResult {
    if (this._parent == null) {
      return { modified: false };
    }

    if (this._parent instanceof LiveList) {
      const previousKey = this._parentKey!;
      this._parent._setChildKey(op.parentKey, this);
      return {
        reverse: [
          { type: OpType.SetParentKey, id: this._id!, parentKey: previousKey },
        ],
        modified: this,
      };
    }

    return { modified: false };
  }

  #applyRegister(op: CreateRegisterOp): ApplyResult {
    if (this._doc == null) {
      throw new Error("Internal: doc should exist");
    }

    if (this._doc.getItem(op.id) != null) {
      return { modified: false };
    }

    return this._attachChild(op.id, op.parentKey, new LiveRegister(op.data));
  }

  #applyCreateObject(op: CreateObjectOp): ApplyResult {
    if (this._doc == null) {
      throw new Error("Internal: doc should exist");
    }

    if (this._doc.getItem(op.id) != null) {
      return { modified: false };
    }

    return this._attachChild(op.id, op.parentKey!, new LiveObject(op.data));
  }

  #applyCreateMap(op: CreateMapOp): ApplyResult {
    if (this._doc == null) {
      throw new Error("Internal: doc should exist");
    }

    if (this._doc.getItem(op.id) != null) {
      return { modified: false };
    }

    return this._attachChild(op.id, op.parentKey!, new LiveMap());
  }

  #applyCreateList(op: CreateListOp): ApplyResult {
    if (this._doc == null) {
      throw new Error("Internal: doc should exist");
    }

    if (this._doc.getItem(op.id) != null) {
      return { modified: false };
    }

    return this._attachChild(op.id, op.parentKey!, new LiveList());
  }

  /**
   * INTERNAL
   */
  _setParentLink(parent: AbstractCrdt, key: string) {
    if (this.#parent != null && this.#parent !== parent) {
      throw new Error("Cannot attach parent if it already exist");
    }

    this.#parentKey = key;
    this.#parent = parent;
  }

  /**
   * INTERNAL
   */
  _attach(id: string, doc: Doc) {
    if (this.#id || this.#doc) {
      throw new Error("Cannot attach if CRDT is already attached");
    }

    doc.addItem(id, this);

    this.#id = id;
    this.#doc = doc;
  }

  /**
   * INTERNAL
   */
  abstract _attachChild(
    id: string,
    key: string,
    crdt: AbstractCrdt
  ): ApplyResult;

  /**
   * INTERNAL
   */
  _detach() {
    if (this.#doc && this.#id) {
      this.#doc.deleteItem(this.#id);
    }

    this.#parent = undefined;
    this.#doc = undefined;
  }

  /**
   * INTERNAL
   */
  abstract _detachChild(crdt: AbstractCrdt): void;
  /**
   * INTERNAL
   */
  abstract _serialize(parentId: string, parentKey: string): Op[];
}

/**
 * The LiveObject class is similar to a JavaScript object that is synchronized on all clients.
 * Keys should be a string, and values should be serializable to JSON.
 * If multiple clients update the same property simultaneously, the last modification received by the Liveblocks servers is the winner.
 */
export class LiveObject<
  T extends Record<string, any> = Record<string, any>
> extends AbstractCrdt {
  #map: Map<string, any>;
  #propToLastUpdate: Map<string, string> = new Map<string, string>();

  constructor(object: T = {} as T) {
    super();

    for (const key in object) {
      const value = object[key] as any;
      if (value instanceof AbstractCrdt) {
        value._setParentLink(this, key);
      }
    }

    this.#map = new Map(Object.entries(object));
  }

  /**
   * INTERNAL
   */
  _serialize(parentId?: string, parentKey?: string): Op[] {
    if (this._id == null) {
      throw new Error("Cannot serialize item is not attached");
    }

    const ops = [];
    const op: CreateObjectOp = {
      id: this._id,
      type: OpType.CreateObject,
      parentId,
      parentKey,
      data: {},
    };

    ops.push(op);

    for (const [key, value] of this.#map) {
      if (value instanceof AbstractCrdt) {
        ops.push(...value._serialize(this._id, key));
      } else {
        op.data[key] = value;
      }
    }

    return ops;
  }

  /**
   * INTERNAL
   */
  static _deserialize(
    [id, item]: SerializedCrdtWithId,
    parentToChildren: Map<string, SerializedCrdtWithId[]>,
    doc: Doc
  ) {
    if (item.type !== CrdtType.Object) {
      throw new Error(
        `Tried to deserialize a record but item type is "${item.type}"`
      );
    }

    const object = new LiveObject(item.data);
    object._attach(id, doc);

    const children = parentToChildren.get(id);

    if (children == null) {
      return object;
    }

    for (const entry of children) {
      const crdt = entry[1];
      if (crdt.parentKey == null) {
        throw new Error(
          "Tried to deserialize a crdt but it does not have a parentKey and is not the root"
        );
      }

      const child = deserialize(entry, parentToChildren, doc);
      child._setParentLink(object, crdt.parentKey);
      object.#map.set(crdt.parentKey, child);
    }

    return object;
  }

  /**
   * INTERNAL
   */
  _attach(id: string, doc: Doc) {
    super._attach(id, doc);

    for (const [key, value] of this.#map) {
      if (value instanceof AbstractCrdt) {
        value._attach(doc.generateId(), doc);
      }
    }
  }

  /**
   * INTERNAL
   */
  _attachChild(id: string, key: keyof T, child: AbstractCrdt): ApplyResult {
    if (this._doc == null) {
      throw new Error("Can't attach child if doc is not present");
    }

    const previousValue = this.#map.get(key as string);
    let reverse: Op[];
    if (isCrdt(previousValue)) {
      reverse = previousValue._serialize(this._id!, key as string);
      previousValue._detach();
    } else if (previousValue === undefined) {
      reverse = [
        { type: OpType.DeleteObjectKey, id: this._id!, key: key as string },
      ];
    } else {
      reverse = [
        {
          type: OpType.UpdateObject,
          id: this._id!,
          data: { [key]: previousValue },
        } as any, // TODO
      ];
    }

    this.#map.set(key as string, child);
    child._setParentLink(this, key as string);
    child._attach(id, this._doc);

    return { reverse, modified: this };
  }

  /**
   * INTERNAL
   */
  _detachChild(child: AbstractCrdt) {
    for (const [key, value] of this.#map) {
      if (value === child) {
        this.#map.delete(key);
      }
    }

    if (child) {
      child._detach();
    }
  }

  /**
   * INTERNAL
   */
  _detach() {
    super._detach();

    for (const value of this.#map.values()) {
      if (isCrdt(value)) {
        value._detach();
      }
    }
  }

  /**
   * INTERNAL
   */
  _apply(op: Op): ApplyResult {
    if (op.type === OpType.UpdateObject) {
      return this.#applyUpdate(op);
    } else if (op.type === OpType.DeleteObjectKey) {
      return this.#applyDeleteObjectKey(op);
    }

    return super._apply(op);
  }

  #applyUpdate(op: UpdateObjectOp): ApplyResult {
    let isModified = false;
    const reverse: Op[] = [];
    const reverseUpdate: UpdateObjectOp = {
      type: OpType.UpdateObject,
      id: this._id!,
      data: {},
    };
    reverse.push(reverseUpdate);

    for (const key in op.data as Partial<T>) {
      const oldValue = this.#map.get(key);
      if (oldValue !== undefined) {
        reverseUpdate.data[key] = oldValue;
      } else if (oldValue === undefined) {
        reverse.push({ type: OpType.DeleteObjectKey, id: this._id!, key });
      }
    }

    let isLocal = false;
    if (op.opId == null) {
      isLocal = true;
      op.opId = this._doc!.generateOpId();
    }

    for (const key in op.data as Partial<T>) {
      if (isLocal) {
        this.#propToLastUpdate.set(key, op.opId);
      } else if (this.#propToLastUpdate.get(key) == null) {
        // Not modified localy so we apply update
        isModified = true;
      } else if (this.#propToLastUpdate.get(key) === op.opId) {
        // Acknowledment from local operation
        this.#propToLastUpdate.delete(key);
        continue;
      } else {
        // Conflict, ignore remote operation
        continue;
      }

      const oldValue = this.#map.get(key);

      if (isCrdt(oldValue)) {
        oldValue._detach();
      }

      isModified = true;
      this.#map.set(key, op.data[key]);
    }
    return isModified ? { modified: this, reverse } : { modified: false };
  }

  #applyDeleteObjectKey(op: DeleteObjectKeyOp): ApplyResult {
    const key = op.key;
    const oldValue = this.#map.get(key);

    let reverse: Op[] = [];
    if (isCrdt(oldValue)) {
      reverse = oldValue._serialize(this._id!, op.key);
      oldValue._detach();
    } else if (oldValue !== undefined) {
      reverse = [
        {
          type: OpType.UpdateObject,
          id: this._id!,
          data: { [key]: oldValue },
        },
      ];
    }

    this.#map.delete(key);
    return { modified: this, reverse };
  }

  /**
   * Transform the LiveObject into a javascript object
   */
  toObject(): T {
    return Object.fromEntries(this.#map) as T;
  }

  /**
   * Adds or updates a property with a specified key and a value.
   * @param key The key of the property to add
   * @param value The value of the property to add
   */
  set<TKey extends keyof T>(key: TKey, value: T[TKey]) {
    // TODO: Find out why typescript complains
    this.update({ [key]: value } as any as Partial<T>);
  }

  /**
   * Returns a specified property from the LiveObject.
   * @param key The key of the property to get
   */
  get<TKey extends keyof T>(key: TKey): T[TKey] {
    return this.#map.get(key as string);
  }

  /**
   * Adds or updates multiple properties at once with an object.
   * @param overrides The object used to overrides properties
   */
  update(overrides: Partial<T>) {
    if (this._doc == null || this._id == null) {
      for (const key in overrides) {
        const oldValue = this.#map.get(key);

        if (oldValue instanceof AbstractCrdt) {
          oldValue._detach();
        }

        const newValue = overrides[key] as any;

        if (newValue instanceof AbstractCrdt) {
          newValue._setParentLink(this, key);
        }

        this.#map.set(key, newValue);
      }

      return;
    }

    const ops: Op[] = [];
    const reverseOps: Op[] = [];

    const opId = this._doc.generateOpId();
    const updatedProps: Partial<T> = {};
    // const updateOp: UpdateObjectOp = {
    //   opId,
    //   id: this._id,
    //   type: OpType.UpdateObject,
    //   data: {},
    // };
    // ops.push(updateOp);

    const reverseUpdateOp: UpdateObjectOp = {
      id: this._id,
      type: OpType.UpdateObject,
      data: {},
    };
    reverseOps.push(reverseUpdateOp);

    for (const key in overrides) {
      this.#propToLastUpdate.set(key, opId);

      const oldValue = this.#map.get(key);

      if (oldValue instanceof AbstractCrdt) {
        reverseOps.push(...oldValue._serialize(this._id, key));
        oldValue._detach();
      } else if (oldValue === undefined) {
        reverseOps.push({ type: OpType.DeleteObjectKey, id: this._id, key });
      } else {
        reverseUpdateOp.data[key] = oldValue;
      }

      const newValue = overrides[key] as any;

      if (newValue instanceof AbstractCrdt) {
        newValue._setParentLink(this, key);
        newValue._attach(this._doc.generateId(), this._doc);
        ops.push(...newValue._serialize(this._id, key));
      } else {
        updatedProps[key] = newValue;
      }

      this.#map.set(key, newValue);
    }

    if (Object.keys(updatedProps).length !== 0) {
      ops.unshift({
        opId,
        id: this._id,
        type: OpType.UpdateObject,
        data: updatedProps,
      });
    }

    this._doc.dispatch(ops, reverseOps, [this]);
  }
}

/**
 * The LiveMap class is similar to a JavaScript Map that is synchronized on all clients.
 * Keys should be a string, and values should be serializable to JSON.
 * If multiple clients update the same property simultaneously, the last modification received by the Liveblocks servers is the winner.
 */
export class LiveMap<TKey extends string, TValue> extends AbstractCrdt {
  #map: Map<TKey, AbstractCrdt>;

  constructor(
    entries?: readonly (readonly [TKey, TValue])[] | null | undefined
  ) {
    super();
    if (entries) {
      const mappedEntries: Array<[TKey, AbstractCrdt]> = [];
      for (const entry of entries) {
        const value = selfOrRegister(entry[1]);
        value._setParentLink(this, entry[0]);
        mappedEntries.push([entry[0], value]);
      }

      this.#map = new Map(mappedEntries);
    } else {
      this.#map = new Map();
    }
  }

  /**
   * INTERNAL
   */
  _serialize(parentId?: string, parentKey?: string): Op[] {
    if (this._id == null) {
      throw new Error("Cannot serialize item is not attached");
    }

    if (parentId == null || parentKey == null) {
      throw new Error(
        "Cannot serialize map if parentId or parentKey is undefined"
      );
    }

    const ops = [];
    const op: CreateMapOp = {
      id: this._id,
      type: OpType.CreateMap,
      parentId,
      parentKey,
    };

    ops.push(op);

    for (const [key, value] of this.#map) {
      ops.push(...value._serialize(this._id, key));
    }

    return ops;
  }

  /**
   * INTERNAL
   */
  static _deserialize(
    [id, item]: SerializedCrdtWithId,
    parentToChildren: Map<string, SerializedCrdtWithId[]>,
    doc: Doc
  ) {
    if (item.type !== CrdtType.Map) {
      throw new Error(
        `Tried to deserialize a map but item type is "${item.type}"`
      );
    }

    const map = new LiveMap();
    map._attach(id, doc);

    const children = parentToChildren.get(id);

    if (children == null) {
      return map;
    }

    for (const entry of children) {
      const crdt = entry[1];
      if (crdt.parentKey == null) {
        throw new Error(
          "Tried to deserialize a crdt but it does not have a parentKey and is not the root"
        );
      }

      const child = deserialize(entry, parentToChildren, doc);
      child._setParentLink(map, crdt.parentKey);
      map.#map.set(crdt.parentKey, child);
    }

    return map;
  }

  /**
   * INTERNAL
   */
  _attach(id: string, doc: Doc) {
    super._attach(id, doc);

    for (const [key, value] of this.#map) {
      if (isCrdt(value)) {
        value._attach(doc.generateId(), doc);
      }
    }
  }

  /**
   * INTERNAL
   */
  _attachChild(id: string, key: TKey, child: AbstractCrdt): ApplyResult {
    if (this._doc == null) {
      throw new Error("Can't attach child if doc is not present");
    }

    const previousValue = this.#map.get(key);
    let reverse: Op[];
    if (previousValue) {
      reverse = previousValue._serialize(this._id!, key);
      previousValue._detach();
    } else {
      reverse = [{ type: OpType.DeleteCrdt, id }];
    }

    child._setParentLink(this, key);
    child._attach(id, this._doc);
    this.#map.set(key, child);

    return { modified: this, reverse };
  }

  /**
   * INTERNAL
   */
  _detach() {
    super._detach();

    for (const item of this.#map.values()) {
      item._detach();
    }
  }

  /**
   * INTERNAL
   */
  _detachChild(child: AbstractCrdt) {
    for (const [key, value] of this.#map) {
      if (value === (child as any)) {
        this.#map.delete(key);
      }
    }

    child._detach();
  }

  /**
   * Returns a specified element from the LiveMap.
   * @param key The key of the element to return.
   * @returns The element associated with the specified key, or undefined if the key can't be found in the LiveMap.
   */
  get(key: TKey): TValue | undefined {
    const value = this.#map.get(key);
    if (value == undefined) {
      return undefined;
    }
    return selfOrRegisterValue(value);
  }

  /**
   * Adds or updates an element with a specified key and a value.
   * @param key The key of the element to add. Should be a string.
   * @param value The value of the element to add. Should be serializable to JSON.
   */
  set(key: TKey, value: TValue) {
    const oldValue = this.#map.get(key);

    if (oldValue) {
      oldValue._detach();
    }

    const item = selfOrRegister(value);
    item._setParentLink(this, key);

    this.#map.set(key, item);

    if (this._doc && this._id) {
      const id = this._doc.generateId();
      item._attach(id, this._doc);
      this._doc.dispatch(
        item._serialize(this._id, key),
        oldValue
          ? oldValue._serialize(this._id, key)
          : [{ type: OpType.DeleteCrdt, id }],
        [this]
      );
    }
  }

  /**
   * Returns the number of elements in the LiveMap.
   */
  get size() {
    return this.#map.size;
  }

  /**
   * Returns a boolean indicating whether an element with the specified key exists or not.
   * @param key The key of the element to test for presence.
   */
  has(key: TKey): boolean {
    return this.#map.has(key);
  }

  /**
   * Removes the specified element by key.
   * @param key The key of the element to remove.
   * @returns true if an element existed and has been removed, or false if the element does not exist.
   */
  delete(key: TKey): boolean {
    const item = this.#map.get(key);

    if (item == null) {
      return false;
    }

    item._detach();

    if (this._doc && item._id) {
      this._doc.dispatch(
        [{ type: OpType.DeleteCrdt, id: item._id }],
        item._serialize(this._id!, key),
        [this]
      );
    }

    this.#map.delete(key);
    return true;
  }

  /**
   * Returns a new Iterator object that contains the [key, value] pairs for each element.
   */
  entries(): IterableIterator<[string, TValue]> {
    const innerIterator = this.#map.entries();

    return {
      [Symbol.iterator]: function () {
        return this;
      },
      next() {
        const iteratorValue = innerIterator.next();

        if (iteratorValue.done) {
          return {
            done: true,
            value: undefined,
          };
        }

        const entry = iteratorValue.value;

        return {
          value: [entry[0], selfOrRegisterValue(iteratorValue.value[1])],
        };
      },
    };
  }

  /**
   * Same function object as the initial value of the entries method.
   */
  [Symbol.iterator](): IterableIterator<[string, TValue]> {
    return this.entries();
  }

  /**
   * Returns a new Iterator object that contains the keys for each element.
   */
  keys(): IterableIterator<TKey> {
    return this.#map.keys();
  }

  /**
   * Returns a new Iterator object that contains the values for each element.
   */
  values(): IterableIterator<TValue> {
    const innerIterator = this.#map.values();

    return {
      [Symbol.iterator]: function () {
        return this;
      },
      next() {
        const iteratorValue = innerIterator.next();

        if (iteratorValue.done) {
          return {
            done: true,
            value: undefined,
          };
        }

        return {
          value: selfOrRegisterValue(iteratorValue.value),
        };
      },
    };
  }

  /**
   * Executes a provided function once per each key/value pair in the Map object, in insertion order.
   * @param callback Function to execute for each entry in the map.
   */
  forEach(
    callback: (value: TValue, key: TKey, map: LiveMap<TKey, TValue>) => void
  ) {
    for (const entry of this) {
      callback(entry[1], entry[0] as TKey, this);
    }
  }
}

/**
 * INTERNAL
 */
class LiveRegister<TValue = any> extends AbstractCrdt {
  #data: TValue;

  constructor(data: TValue) {
    super();
    this.#data = data;
  }

  get data() {
    return this.#data;
  }

  /**
   * INTERNAL
   */
  static _deserialize(
    [id, item]: SerializedCrdtWithId,
    parentToChildren: Map<string, SerializedCrdtWithId[]>,
    doc: Doc
  ) {
    if (item.type !== CrdtType.Register) {
      throw new Error(
        `Tried to deserialize a map but item type is "${item.type}"`
      );
    }

    const register = new LiveRegister(item.data);
    register._attach(id, doc);
    return register;
  }

  /**
   * INTERNAL
   */
  _serialize(parentId: string, parentKey: string): Op[] {
    if (this._id == null || parentId == null || parentKey == null) {
      throw new Error(
        "Cannot serialize register if parentId or parentKey is undefined"
      );
    }

    return [
      {
        type: OpType.CreateRegister,
        id: this._id,
        parentId,
        parentKey,
        data: this.data,
      },
    ];
  }

  _attachChild(id: string, key: string, crdt: AbstractCrdt): ApplyResult {
    throw new Error("Method not implemented.");
  }

  _detachChild(crdt: AbstractCrdt): void {
    throw new Error("Method not implemented.");
  }

  _apply(op: Op): ApplyResult {
    return super._apply(op);
  }
}

type LiveListItem = [crdt: AbstractCrdt, position: string];

/**
 * The LiveList class represents an ordered collection of items that is synchorinized across clients.
 */
export class LiveList<T> extends AbstractCrdt {
  // TODO: Naive array at first, find a better data structure. Maybe an Order statistics tree?
  #items: Array<LiveListItem> = [];

  constructor(items: T[] = []) {
    super();
    let position = undefined;
    for (let i = 0; i < items.length; i++) {
      const newPosition = makePosition(position);
      const item = selfOrRegister(items[i]);
      this.#items.push([item, newPosition]);
      position = newPosition;
    }
  }

  /**
   * INTERNAL
   */
  static _deserialize(
    [id, item]: [id: string, item: SerializedList],
    parentToChildren: Map<string, SerializedCrdtWithId[]>,
    doc: Doc
  ) {
    const list = new LiveList([]);
    list._attach(id, doc);

    const children = parentToChildren.get(id);

    if (children == null) {
      return list;
    }

    for (const entry of children) {
      const child = deserialize(entry, parentToChildren, doc);

      child._setParentLink(list, entry[1].parentKey!);

      list.#items.push([child, entry[1].parentKey!]);
      list.#items.sort((itemA, itemB) => compare(itemA[1], itemB[1]));
    }

    return list;
  }

  /**
   * INTERNAL
   */
  _serialize(parentId?: string, parentKey?: string): Op[] {
    if (this._id == null) {
      throw new Error("Cannot serialize item is not attached");
    }

    if (parentId == null || parentKey == null) {
      throw new Error(
        "Cannot serialize list if parentId or parentKey is undefined"
      );
    }

    const ops = [];
    const op: CreateListOp = {
      id: this._id,
      type: OpType.CreateList,
      parentId,
      parentKey,
    };

    ops.push(op);

    for (const [value, key] of this.#items) {
      ops.push(...value._serialize(this._id, key));
    }

    return ops;
  }

  /**
   * INTERNAL
   */
  _attach(id: string, doc: Doc) {
    super._attach(id, doc);

    for (const [item, position] of this.#items) {
      item._attach(doc.generateId(), doc);
    }
  }

  /**
   * INTERNAL
   */
  _detach() {
    super._detach();

    for (const [value] of this.#items) {
      value._detach();
    }
  }

  /**
   * INTERNAL
   */
  _attachChild(id: string, key: string, child: AbstractCrdt): ApplyResult {
    if (this._doc == null) {
      throw new Error("Can't attach child if doc is not present");
    }

    child._attach(id, this._doc);
    child._setParentLink(this, key);

    const index = this.#items.findIndex((entry) => entry[1] === key);

    // Assign a temporary position until we get the fix from the backend
    if (index !== -1) {
      this.#items[index][1] = makePosition(key, this.#items[index + 1]?.[1]);
    }

    this.#items.push([child, key]);
    this.#items.sort((itemA, itemB) => compare(itemA[1], itemB[1]));

    return { reverse: [{ type: OpType.DeleteCrdt, id }], modified: this };
  }

  /**
   * INTERNAL
   */
  _detachChild(child: AbstractCrdt) {
    const indexToDelete = this.#items.findIndex((item) => item[0] === child);
    this.#items.splice(indexToDelete, 1);
    if (child) {
      child._detach();
    }
  }

  /**
   * INTERNAL
   */
  _setChildKey(key: string, child: AbstractCrdt) {
    child._setParentLink(this, key);

    const index = this.#items.findIndex((entry) => entry[1] === key);

    // Assign a temporary position until we get the fix from the backend
    if (index !== -1) {
      this.#items[index][1] = makePosition(key, this.#items[index + 1]?.[1]);
    }

    const item = this.#items.find((item) => item[0] === child);

    if (item) {
      item[1] = key;
    }

    this.#items.sort((itemA, itemB) => compare(itemA[1], itemB[1]));
  }

  /**
   * INTERNAL
   */
  _apply(op: Op) {
    return super._apply(op);
  }

  /**
   * Returns the number of elements.
   */
  get length() {
    return this.#items.length;
  }

  /**
   * Adds one element to the end of the LiveList.
   * @param element The element to add to the end of the LiveList.
   */
  push(element: T) {
    return this.insert(element, this.length);
  }

  /**
   * Inserts one element at a specified index.
   * @param element The element to insert.
   * @param index The index at which you want to insert the element.
   */
  insert(element: T, index: number) {
    if (index < 0 || index > this.#items.length) {
      throw new Error(
        `Cannot delete list item at index "${index}". index should be between 0 and ${
          this.#items.length
        }`
      );
    }

    let before = this.#items[index - 1] ? this.#items[index - 1][1] : undefined;
    let after = this.#items[index] ? this.#items[index][1] : undefined;
    const position = makePosition(before, after);

    const value = selfOrRegister(element);
    value._setParentLink(this, position);

    this.#items.push([value, position]);
    this.#items.sort((itemA, itemB) => compare(itemA[1], itemB[1]));

    if (this._doc && this._id) {
      const id = this._doc.generateId();
      value._attach(id, this._doc);
      this._doc.dispatch(
        value._serialize(this._id, position),
        [{ type: OpType.DeleteCrdt, id }],
        [this]
      );
    }
  }

  /**
   * Move one element from one index to another.
   * @param index The index of the element to move
   * @param targetIndex The index where the element should be after moving.
   */
  move(index: number, targetIndex: number) {
    if (targetIndex < 0) {
      throw new Error("targetIndex cannot be less than 0");
    }

    if (targetIndex >= this.#items.length) {
      throw new Error(
        "targetIndex cannot be greater or equal than the list length"
      );
    }

    if (index < 0) {
      throw new Error("index cannot be less than 0");
    }

    if (index >= this.#items.length) {
      throw new Error("index cannot be greater or equal than the list length");
    }

    let beforePosition = null;
    let afterPosition = null;

    if (index < targetIndex) {
      afterPosition =
        targetIndex === this.#items.length - 1
          ? undefined
          : this.#items[targetIndex + 1][1];
      beforePosition = this.#items[targetIndex][1];
    } else {
      afterPosition = this.#items[targetIndex][1];
      beforePosition =
        targetIndex === 0 ? undefined : this.#items[targetIndex - 1][1];
    }

    const position = makePosition(beforePosition, afterPosition);

    const item = this.#items[index];
    const previousPosition = item[1];
    item[1] = position;
    item[0]._setParentLink(this, position);
    this.#items.sort((itemA, itemB) => compare(itemA[1], itemB[1]));

    if (this._doc && this._id) {
      this._doc.dispatch(
        [
          {
            type: OpType.SetParentKey,
            id: item[0]._id!,
            parentKey: position,
          },
        ],
        [
          {
            type: OpType.SetParentKey,
            id: item[0]._id!,
            parentKey: previousPosition,
          },
        ],
        [this]
      );
    }
  }

  /**
   * Deletes an element at the specified index
   * @param index The index of the element to delete
   */
  delete(index: number) {
    if (index < 0 || index >= this.#items.length) {
      throw new Error(
        `Cannot delete list item at index "${index}". index should be between 0 and ${
          this.#items.length - 1
        }`
      );
    }

    const item = this.#items[index];
    item[0]._detach();
    this.#items.splice(index, 1);

    if (this._doc) {
      const childRecordId = item[0]._id;
      if (childRecordId) {
        this._doc.dispatch(
          [
            {
              id: childRecordId,
              type: OpType.DeleteCrdt,
            },
          ],
          item[0]._serialize(this._id!, item[1]),
          [this]
        );
      }
    }
  }

  /**
   * Returns an Array of all the elements in the LiveList.
   */
  toArray(): T[] {
    return this.#items.map((entry) => selfOrRegisterValue(entry[0]));
  }

  /**
   * Tests whether all elements pass the test implemented by the provided function.
   * @param predicate Function to test for each element, taking two arguments (the element and its index).
   * @returns true if the predicate function returns a truthy value for every element. Otherwise, false.
   */
  every(predicate: (value: T, index: number) => unknown): boolean {
    return this.toArray().every(predicate);
  }

  /**
   * Creates an array with all elements that pass the test implemented by the provided function.
   * @param predicate Function to test each element of the LiveList. Return a value that coerces to true to keep the element, or to false otherwise.
   * @returns An array with the elements that pass the test.
   */
  filter(predicate: (value: T, index: number) => unknown): T[] {
    return this.toArray().filter(predicate);
  }

  /**
   * Returns the first element that satisfies the provided testing function.
   * @param predicate Function to execute on each value.
   * @returns The value of the first element in the LiveList that satisfies the provided testing function. Otherwise, undefined is returned.
   */
  find(predicate: (value: T, index: number) => unknown): T | undefined {
    return this.toArray().find(predicate);
  }

  /**
   * Returns the index of the first element in the LiveList that satisfies the provided testing function.
   * @param predicate Function to execute on each value until the function returns true, indicating that the satisfying element was found.
   * @returns The index of the first element in the LiveList that passes the test. Otherwise, -1.
   */
  findIndex(predicate: (value: T, index: number) => unknown): number {
    return this.toArray().findIndex(predicate);
  }

  /**
   * Executes a provided function once for each element.
   * @param callbackfn Function to execute on each element.
   */
  forEach(callbackfn: (value: T, index: number) => void): void {
    return this.toArray().forEach(callbackfn);
  }

  /**
   * Get the element at the specified index.
   * @param index The index on the element to get.
   * @returns The element at the specified index or undefined.
   */
  get(index: number): T | undefined {
    if (index < 0 || index >= this.#items.length) {
      return undefined;
    }

    return selfOrRegisterValue(this.#items[index][0]);
  }

  /**
   * Returns the first index at which a given element can be found in the LiveList, or -1 if it is not present.
   * @param searchElement Element to locate.
   * @param fromIndex The index to start the search at.
   * @returns The first index of the element in the LiveList; -1 if not found.
   */
  indexOf(searchElement: T, fromIndex?: number): number {
    return this.toArray().indexOf(searchElement, fromIndex);
  }

  /**
   * Returns the last index at which a given element can be found in the LiveList, or -1 if it is not present. The LiveLsit is searched backwards, starting at fromIndex.
   * @param searchElement Element to locate.
   * @param fromIndex The index at which to start searching backwards.
   * @returns
   */
  lastIndexOf(searchElement: T, fromIndex?: number): number {
    return this.toArray().lastIndexOf(searchElement, fromIndex);
  }

  /**
   * Creates an array populated with the results of calling a provided function on every element.
   * @param callback Function that is called for every element.
   * @returns An array with each element being the result of the callback function.
   */
  map<U>(callback: (value: T, index: number) => U): U[] {
    return this.#items.map((entry, i) =>
      callback(selfOrRegisterValue(entry[0]), i)
    );
  }

  /**
   * Tests whether at least one element in the LiveList passes the test implemented by the provided function.
   * @param predicate Function to test for each element.
   * @returns true if the callback function returns a truthy value for at least one element. Otherwise, false.
   */
  some(predicate: (value: T, index: number) => unknown): boolean {
    return this.toArray().some(predicate);
  }

  [Symbol.iterator](): IterableIterator<T> {
    return new LiveListIterator(this.#items);
  }
}

class LiveListIterator<T> implements IterableIterator<T> {
  #innerIterator: IterableIterator<LiveListItem>;

  constructor(items: Array<LiveListItem>) {
    this.#innerIterator = items[Symbol.iterator]();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this;
  }

  next(): IteratorResult<T> {
    const result = this.#innerIterator.next();

    if (result.done) {
      return {
        done: true,
        value: undefined,
      };
    }

    return {
      value: selfOrRegisterValue(result.value[0]),
    };
  }
}

function deserialize(
  entry: SerializedCrdtWithId,
  parentToChildren: Map<string, SerializedCrdtWithId[]>,
  doc: Doc
): AbstractCrdt {
  switch (entry[1].type) {
    case CrdtType.Object: {
      return LiveObject._deserialize(entry, parentToChildren, doc);
    }
    case CrdtType.List: {
      return LiveList._deserialize(
        entry as [string, SerializedList],
        parentToChildren,
        doc
      );
    }
    case CrdtType.Map: {
      return LiveMap._deserialize(
        entry as [string, SerializedMap],
        parentToChildren,
        doc
      );
    }
    case CrdtType.Register: {
      return LiveRegister._deserialize(
        entry as [string, SerializedMap],
        parentToChildren,
        doc
      );
    }
    default: {
      throw new Error("Unexpected CRDT type");
    }
  }
}

function isCrdt(obj: any): obj is AbstractCrdt {
  return (
    obj instanceof LiveObject ||
    obj instanceof LiveMap ||
    obj instanceof LiveList ||
    obj instanceof LiveRegister
  );
}

function selfOrRegisterValue(obj: AbstractCrdt) {
  if (obj instanceof LiveRegister) {
    return obj.data;
  }

  return obj;
}

function selfOrRegister(obj: any): AbstractCrdt {
  if (
    obj instanceof LiveObject ||
    obj instanceof LiveMap ||
    obj instanceof LiveList
  ) {
    return obj;
  } else if (obj instanceof LiveRegister) {
    throw new Error(
      "Internal error. LiveRegister should not be created from selfOrRegister"
    );
  } else {
    return new LiveRegister(obj);
  }
}
