import { Router } from "express";
import { contracts } from "../chain";
import { requireAuth } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, async (_req, res) => {
  const total = await contracts.workflow.totalProposals();
  const proposals = [];
  for (let i = 1; i <= Number(total); i++) {
    try {
      const p = await contracts.workflow.getProposal(i);
      if (!p.executed && !p.rejected) {
        proposals.push({
          pid: i,
          kind: Number(p.kind),
          resourceId: p.resourceId,
          principal: p.principal,
          targetIdentity: Number(p.targetIdentity),
          targetDid: p.targetDid,
          allowMask: Number(p.allowMask),
          denyMask: Number(p.denyMask),
          expiresAt: Number(p.expiresAt),
          delegationDepth: Number(p.delegationDepth),
          tier: Number(p.tier),
          contentHash: p.contentHash,
          justificationHash: p.justificationHash,
          proposer: Number(p.proposer),
          approvers: p.approvers.map(Number),
          readyAt: Number(p.readyAt),
          executed: p.executed,
          rejected: p.rejected,
          breakGlass: p.breakGlass,
        });
      }
    } catch (e) {
      // Ignored
    }
  }
  res.json(proposals);
});

export default router;
