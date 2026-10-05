// Generated bindings and captured delivery only; no production entry is exposed.
import { openMembershipLifecycle } from '../packages/postgres/src/membership.mjs';
import { createWorkspaceAdmission } from './workspace-admission.mjs';

export default {
  async fetch(request, env) {
    const client=openMembershipLifecycle({connectionString:env.FIXTURE_CONNECTION,
      trustedOrigin:env.FIXTURE_ORIGIN,sessionSecret:env.FIXTURE_SECRET,
      authorize:async(original,facts)=>{
        const admission=createWorkspaceAdmission({kind:'hosted',profile:Symbol('fixture-membership'),
          trustedOrigin:env.FIXTURE_ORIGIN,membership:async()=>facts});
        await admission.withAdmission('memberships.manage',{requestedWorkspaceId:facts.workspaceId,
          correlationId:'worker-membership'},original,async()=>undefined);
      },
      deliver:async(message)=>{
        const response=await env.CAPTURE_MAIL.fetch('https://fixture.example.test/capture',
          {method:'POST',body:JSON.stringify(message)});
        if(!response.ok)throw new Error('Captured delivery refused');
        await response.arrayBuffer();
      },
    });
    try {
      const {workspaceId,command}=await request.json();
      return await client.execute(request,workspaceId,command);
    } catch {
      return new Response(JSON.stringify({ok:false}),{status:403,
        headers:{'content-type':'application/json','cache-control':'no-store'}});
    } finally {await client.close();}
  },
};
