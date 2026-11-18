#!/usr/bin/env node
// Prepare a new local customer workspace and enroll its verified first owner.
import { ownerEnrollmentMain } from './standalone-owner.mjs';

process.exitCode = await ownerEnrollmentMain(process.argv.slice(2), { newWorkspace: true });
