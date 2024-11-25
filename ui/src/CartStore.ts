import {
  type AgentPubKeyB64,
  type DnaHash,
  type Record,
  encodeHashToBase64,
  type AnyDhtHash,
} from "@holochain/client";
import { writable, type Writable, get } from "svelte/store";
import type { Group } from "./board";
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

export interface CartState {
  visibleCarts: Group[];
  cartData: { [key: string]: Cart };
  loading: boolean;
  error: string | null;
}

export class CartStore {
  private state: Writable<CartState>;
  private myAgentKey: AgentPubKeyB64;

  constructor(private synStore: SynStore, myAgentKey: AgentPubKeyB64) {
    this.myAgentKey = myAgentKey;
    this.state = writable({
      visibleCarts: [],
      cartData: {},
      loading: false,
      error: null,
    });
  }

  // Convert cart record to Group for UI
  private cartToGroup(cart: Cart): Group {
    const group = new Group(`Cart ${cart.created_at}`);
    // Use cart DNA hash as group ID to maintain connection
    group.id = `cart_${encodeHashToBase64(cart.cart_dna_hash)}`;
    return group;
  }

  // Parse cart data from Holochain record
  private parseCartRecord(record: Record): Cart | null {
    try {
      if (!record.entry?.Present?.entry) return null;

      const cartData = decode(record.entry.Present.entry) as Cart;
      return cartData;
    } catch (error) {
      console.error("Error parsing cart record:", error);
      return null;
    }
  }

  // Load all accessible carts
  async loadCarts(): Promise<void> {
    this.state.update((s) => ({ ...s, loading: true, error: null }));

    try {
      // Get all carts using the new DNA clone approach
      const result = await this.synStore.client.callZome({
        role_name: "syn",
        zome_name: "syn",
        fn_name: "get_all_carts",
        payload: null,
      });

      const validCarts: Group[] = [];
      const cartData: { [key: string]: Cart } = {};

      for (const record of result) {
        const cart = this.parseCartRecord(record);
        if (!cart) continue;

        // Check ownership - only show carts owned by this agent
        if (cart.owner === this.myAgentKey) {
          const group = this.cartToGroup(cart);
          validCarts.push(group);
          cartData[group.id] = cart;
        }
      }

      this.state.update((s) => ({
        ...s,
        visibleCarts: validCarts,
        cartData,
        loading: false,
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

  // Create a new cart with DNA clone
  async createCart(documentHash: AnyDhtHash, name: string): Promise<void> {
    try {
      const result = await this.synStore.client.callZome({
        role_name: "syn",
        zome_name: "syn",
        fn_name: "create_cart",
        payload: {
          document_hash: documentHash,
          cart_name: name,
        },
      });

      if (result?.entry?.Present?.entry) {
        const cartData = decode(result.entry.Present.entry) as Cart;
        console.log("Cart created:", {
          originalDna: encodeHashToBase64(cartData.original_dna_hash),
          cartDna: encodeHashToBase64(cartData.cart_dna_hash),
        });
      }

      await this.loadCarts();
    } catch (error) {
      console.error("Error creating cart:", error);
      throw error;
    }
  }

  // Get cart data by group ID
  getCartData(groupId: string): Cart | null {
    const state = get(this.state);
    return state.cartData[groupId] || null;
  }

  // Subscribe to cart state changes
  subscribe(callback: (state: CartState) => void) {
    return this.state.subscribe(callback);
  }
}
