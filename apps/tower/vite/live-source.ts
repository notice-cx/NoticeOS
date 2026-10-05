import path from 'node:path';
import { watch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { Plugin } from 'vite';

/** Refresh provenance and recheck startup inputs in an explicit source mode. */
export function liveSource({ sourceRoot, codeRoot }: {sourceRoot:string;codeRoot:string}): Plugin {
  return { name:'noticeos-live-source-version', configureServer(server) {
    let observer: ReturnType<typeof watch> | undefined;
    const git=spawnSync('git',['-c',`safe.directory=${sourceRoot}`,'-c',`core.worktree=${sourceRoot}`,'-C',sourceRoot,
      'rev-parse','--path-format=absolute','--git-path','logs/HEAD'],{encoding:'utf8',timeout:2000,maxBuffer:8192});
    const restart=()=>{void server.restart().catch(()=>server.config.logger.error('Live source restart failed.'));};
    // Watch the containing directory so atomic Git updates remain observable.
    try {if(git.status===0) observer=watch(path.dirname(git.stdout.trim()),(_event,file)=>{
      if(file?.toString()==='HEAD') restart();
    });} catch { /* A source archive can run without Git metadata. */ }
    const watched=['pnpm-lock.yaml','pnpm-workspace.yaml','package.json','apps/tower/package.json','workers/ingest/package.json',
      'packages/contract/package.json','packages/mediavine/package.json','packages/postgres/package.json',
      'apps/tower/wrangler.jsonc','workers/ingest/wrangler.jsonc'].map(file=>path.resolve(codeRoot,file));
    server.watcher.add(watched);
    const changed=(file:string)=>{if(watched.includes(file)) restart();};
    server.watcher.on('change',changed);
    server.httpServer?.once('close',()=>{observer?.close();server.watcher.off('change',changed);});
  }};
}
