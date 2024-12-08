import {
    type AppClient,
    type EntryHash,
    type AgentPubKeyB64,
    type AppCallZomeRequest,
    type RoleName,
    encodeHashToBase64,
    type EntryHashB64,
    type AgentPubKey,
    type DnaHash,
  } from '@holochain/client';
import { SynStore,  SynClient, type Commit } from '@holochain-syn/core';
import { BoardList } from './boardList';
import TimeAgo from "javascript-time-ago"
import en from 'javascript-time-ago/locale/en'

import { writable, type Writable } from "svelte/store";
import type { ProfilesStore } from '@holochain-open-dev/profiles';
import type { WeaveClient } from '@theweave/api';
import { getMyDna } from './util';
import { CartStore } from "./CartStore";
import { getContext } from "svelte";

TimeAgo.addDefaultLocale(en)

const ZOME_NAME = 'syn'

export class TalkingStickiesService {
    constructor(public client: AppClient, public roleName, public zomeName = ZOME_NAME) {}

    private callZome(fnName: string, payload: any) {
        const req: AppCallZomeRequest = {
            role_name: this.roleName,
            zome_name: this.zomeName,
            fn_name: fnName,
            payload
          }
        return this.client.callZome(req);
    }
}

export interface UIProps {
    showArchived: {[key: string]: boolean},
    showMenu: boolean,
    recent: Array<EntryHashB64>
    bgUrl: string
  }
  
export class TalkingStickiesStore {
  myAgentPubKeyB64: AgentPubKeyB64;
  timeAgo = new TimeAgo("en-US");
  service: TalkingStickiesService;
  boardList: BoardList;
  cartStore: CartStore; // Add this
  updating = false;
  synStore: SynStore;
  client: AppClient;
  uiProps: Writable<UIProps> = writable({
    showArchived: {},
    showMenu: true,
    recent: [],
    bgUrl: "",
  });
  dnaHash: DnaHash;

  setUIprops(props: {}) {
    this.uiProps.update((n) => {
      Object.keys(props).forEach((key) => (n[key] = props[key]));
      return n;
    });
  }

  async setActiveBoard(hash: EntryHash | undefined) {
    const board = await this.boardList.setActiveBoard(hash);
    let bgUrl = "";
    if (board) {
      const state = board.state();
      if (state) {
        bgUrl = state.props.bgUrl;
      }

      const cloneInfos = await this.service.callZome("get_cart_clones", null);
      console.log("get_cart_clones result:", cloneInfos);

      console.log(
        "ALL CLONE INFOS:",
        cloneInfos.map((info) => ({
          dna: encodeHashToBase64(info.cart_dna_hash),
          owner: encodeHashToBase64(info.agent_key),
        }))
      );

      if (cloneInfos && cloneInfos.length > 0) {
        const cartCells = {};
        for (const info of cloneInfos) {
          console.log("Clone info details:", {
            dna_hash: encodeHashToBase64(info.dna_hash),
            cart_dna_hash: encodeHashToBase64(info.cart_dna_hash),
            agent_key: encodeHashToBase64(info.agent_key),
          });
          const cartId = `cart_${encodeHashToBase64(info.cart_dna_hash)}_${
            info.created_at
          }`;
          console.log("Processing clone info:", {
            info,
            cartId,
            cell_id: [info.cart_dna_hash, info.agent_key],
          });
          cartCells[cartId] = {
            cell_id: [info.cart_dna_hash, info.agent_key] as [
              Uint8Array,
              Uint8Array
            ],
            network_seed: "",
          };
        }
        this.cartStore.state.update((state) => ({
          ...state,
          cartCells,
        }));
        await this.cartStore.loadCarts();
      }
    }
    this.setUIprops({ showMenu: false, bgUrl });
  }

  async closeActiveBoard(leave: boolean) {
    await this.boardList.closeActiveBoard(leave);
    this.setUIprops({ showMenu: true, bgUrl: "" });
  }

  async archiveBoard(documentHash: EntryHash) {
    const wasActive = this.boardList.archiveBoard(documentHash);
    if (wasActive) {
      this.setUIprops({ showMenu: true, bgUrl: "" });
    }
  }

  async unarchiveBoard(documentHash: EntryHash) {
    this.boardList.unarchiveBoard(documentHash);
  }

  get myAgentPubKey(): AgentPubKey {
    return this.client.myPubKey;
  }

  constructor(
    public weaveClient: WeaveClient,
    public profilesStore: ProfilesStore,
    protected clientIn: AppClient,
    public roleName: RoleName,
    public zomeName: string = ZOME_NAME
  ) {
    this.client = clientIn;
    getMyDna(roleName, clientIn).then((res) => {
      this.dnaHash = res;
    });

    this.myAgentPubKeyB64 = encodeHashToBase64(this.client.myPubKey);
    this.service = new TalkingStickiesService(
      this.client,
      this.roleName,
      this.zomeName
    );
    this.synStore = new SynStore(
      new SynClient(this.client, this.roleName, this.zomeName)
    );
    this.boardList = new BoardList(profilesStore, this.synStore);
    const roleStore = getContext("currentRole");
    this.cartStore = new CartStore(
      this.synStore,
      this.myAgentPubKeyB64,
      roleStore
    );
  }
}