import {
  type AgentPubKeyB64,
  type DnaHash,
  type Record,
  type CellId,
  type AgentPubKey, // Add this
  encodeHashToBase64,
  type AnyDhtHash,
} from "@holochain/client";
import { writable, type Writable, get } from "svelte/store";
import { Group } from "./board";
import { SynStore } from "@holochain-syn/core";
import { decode } from "@msgpack/msgpack";

export interface Cart {
  original_dna_hash: DnaHash;
  cart_dna_hash: DnaHash;
  document_hash: AnyDhtHash;
  owner: AgentPubKeyB64;
  status: "Active" | "CheckedOut" | "Processed";
  created_at: number;
  meta?: any;
}

interface CartCloneInfo {
  cell_id: [Uint8Array, Uint8Array]; // Explicitly type as tuple
  network_seed: string;
}

export interface CartState {
  visibleCarts: Group[];
  cartData: { [key: string]: Cart };
  cartCells: { [key: string]: CartCloneInfo }; // Track cell info for each cart
  loading: boolean;
  error: string | null;
}

export class CartStore {
  private state: Writable<CartState>;
  private cartCount = 0;

  constructor(private synStore: SynStore, private myAgentKey: AgentPubKeyB64) {
    this.state = writable({
      visibleCarts: [],
      cartData: {},
      cartCells: {},
      loading: false,
      error: null,
    });
  }

  private cartToGroup(cart: Cart, cloneInfo?: any): Group {
    const id = `cart_${encodeHashToBase64(
      cloneInfo?.cart_dna_hash || cart.cart_dna_hash
    )}_${cloneInfo?.created_at || cart.created_at}`;
    const group = new Group(`Cart ${this.cartCount || 0}`);
    group.id = id;
    return group;
  }

  // Call a zome function on a specific cloned cell
  private async callClonedCell(
    cell_id: [DnaHash, AgentPubKey],
    fn_name: string,
    payload: any
  ): Promise<any> {
    try {
      console.log("Calling zome with:", { fn_name, payload, cell_id });
      const result = await this.synStore.client.callZome(fn_name, payload);
      console.log("Zome call result:", result);
      return result;
    } catch (error) {
      console.error("Cell call failed:", {
        error,
        fn_name,
        cell_id_dna: encodeHashToBase64(cell_id[0]),
        cell_id_agent: encodeHashToBase64(cell_id[1]),
      });
      throw error;
    }
  }

  // And update createCart to store the cell_id correctly
  async createCart(documentHash: AnyDhtHash, name: string): Promise<void> {
    this.state.update((s) => ({ ...s, loading: true, error: null }));

    try {
      const input = {
        document_hash: documentHash,
        cart_name: name,
      };

      // Make the clone call using the correct method signature
      const cloneInfo = await this.synStore.client.callZome(
        "syn", // zome_name
        {
          // payload object
          fn_name: "clone_cart_dna",
          payload: input,
        }
      );

      console.log("Got clone info:", {
        dna: encodeHashToBase64(cloneInfo.cell_id[0]),
        agent: encodeHashToBase64(cloneInfo.cell_id[1]),
      });

      // Create cart entry using proper call format
      const cartRecord = await this.callClonedCell(
        cloneInfo.cell_id,
        "create_cart_entry",
        {
          input: input,
          created_at: cloneInfo.created_at,
        }
      );

      if (cartRecord?.entry?.Present?.entry) {
        const cartData = decode(cartRecord.entry.Present.entry) as Cart;
        console.log("Creating cart with:", {
          cloneInfo_dna: encodeHashToBase64(cloneInfo.dna_hash),
          cloneInfo_cart_dna: encodeHashToBase64(cloneInfo.cart_dna_hash),
          cartData_cart_dna: encodeHashToBase64(cartData.cart_dna_hash),
        });
        console.log("HASHES:", {
          cloneInfo_cart_dna: encodeHashToBase64(cloneInfo.cart_dna_hash),
          cartData_cart_dna: encodeHashToBase64(cartData.cart_dna_hash),
        });

        // Store the cell_id as tuple
        this.state.update((state) => ({
          ...state,
          cartCells: {
            ...state.cartCells,
            [`cart_${encodeHashToBase64(cloneInfo.cart_dna_hash)}_${
              cloneInfo.created_at
            }`]: {
              cell_id: cloneInfo.cell_id as [Uint8Array, Uint8Array],
              network_seed: "",
            },
          },
        }));

        await this.loadCarts();
      }
    } catch (error) {
      console.error("Error creating cart:", error);
      this.state.update((s) => ({
        ...s,
        loading: false,
        error: error.message,
      }));
      throw error;
    }
  }

  // Get all carts for the current user
  async loadCarts(): Promise<void> {
    this.state.update((s) => ({ ...s, loading: true, error: null }));

    try {
      console.log("Loading carts...");
      const validCarts: Group[] = [];
      const cartData: { [key: string]: Cart } = {};
      const cartCells: { [key: string]: CartCloneInfo } = {};

      const state = get(this.state);
      console.log("Current cart cells:", state.cartCells);

      this.cartCount = Object.keys(state.cartCells).length;

      const seenCarts = new Set(); // Track unique carts

      for (const [groupId, cloneInfo] of Object.entries(state.cartCells)) {
        console.log("Attempting to load cart:", {
          groupId,
          cloneInfo,
          cell_id_dna: encodeHashToBase64(cloneInfo.cell_id[0]),
          cell_id_agent: encodeHashToBase64(cloneInfo.cell_id[1]),
        });
        try {
          const records = await this.callClonedCell(
            cloneInfo.cell_id as [Uint8Array, Uint8Array],
            "get_all_carts",
            null
          );

          if (records) {
            for (const record of records) {
              if (!record?.entry?.Present?.entry) continue;
              const cart = decode(record.entry.Present.entry) as Cart;

              // Only process each cart once
              const cartKey = `${encodeHashToBase64(cart.cart_dna_hash)}_${
                cart.created_at
              }`;
              if (seenCarts.has(cartKey)) continue;
              seenCarts.add(cartKey);

              if (encodeHashToBase64(cart.owner) === this.myAgentKey) {
                const group = this.cartToGroup(cart, cloneInfo);
                validCarts.push(group);
                cartData[group.id] = cart;
                cartCells[group.id] = cloneInfo;
              }
            }
          }
        } catch (error) {
          console.error(`Error loading cart from cell ${groupId}:`, error);
        }
      }

      console.log("Loaded carts:", {
        validCarts,
        cartData,
        cartCells,
      });

      this.state.update((s) => ({
        ...s,
        loading: false,
        visibleCarts: validCarts,
        cartData,
        cartCells,
      }));
    } catch (error) {
      console.error("Error loading carts:", error);
      this.state.update((s) => ({
        ...s,
        loading: false,
        error: error.message,
      }));
    }
  }

  getCartData(groupId: string): Cart | null {
    return get(this.state).cartData[groupId] || null;
  }

  getCartCell(groupId: string): CartCloneInfo | null {
    return get(this.state).cartCells[groupId] || null;
  }

  subscribe(callback: (state: CartState) => void) {
    return this.state.subscribe(callback);
  }
}
