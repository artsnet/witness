// The Worker: the witness's three endpoints go to one Durable Object, which
// holds its state and takes requests one at a time; everything else is the
// verification site, served as static files.
import { DurableObject } from 'cloudflare:workers';
import registry from '../public/registry.json';
import { Witness } from './witness.js';

const WITNESS_PATHS = ['/add-checkpoint', '/witness.vkey', '/status.json'];

export class WitnessState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.witness = new Witness({ store: ctx.storage, env, registry });
  }

  fetch(request) {
    return this.witness.handle(request);
  }
}

export default {
  async fetch(request, env) {
    if (WITNESS_PATHS.includes(new URL(request.url).pathname)) return env.WITNESS.get(env.WITNESS.idFromName('witness')).fetch(request);
    return env.ASSETS.fetch(request);
  },
};
