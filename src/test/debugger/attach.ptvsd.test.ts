// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

// tslint:disable:no-invalid-this max-func-body-length no-empty no-increment-decrement

import { ChildProcess, spawn } from 'child_process';
import * as getFreePort from 'get-port';
import * as path from 'path';
import * as TypeMoq from 'typemoq';
import { DebugConfiguration, Uri } from 'vscode';
import { DebugClient } from 'vscode-debugadapter-testsupport';
import { EXTENSION_ROOT_DIR } from '../../client/common/constants';
import '../../client/common/extensions';
import { PTVSD_PATH } from '../../client/debugger/Common/constants';
import { DebugOptions } from '../../client/debugger/Common/Contracts';
import { sleep } from '../common';
import { initialize, IS_APPVEYOR, IS_MULTI_ROOT_TEST, TEST_DEBUGGER } from '../initialize';
import { continueDebugging, createDebugAdapter } from './utils';

const fileToDebug = path.join(EXTENSION_ROOT_DIR, 'src', 'testMultiRootWkspc', 'workspace5', 'remoteDebugger-start-with-ptvsd.py');

suite('Attach Debugger - Experimental', () => {
    let debugClient: DebugClient;
    let procToKill: ChildProcess;
    suiteSetup(initialize);

    setup(async function () {
        if (!IS_MULTI_ROOT_TEST || !TEST_DEBUGGER) {
            this.skip();
        }
        const coverageDirectory = path.join(EXTENSION_ROOT_DIR, 'debug_coverage_attach_ptvsd');
        debugClient = await createDebugAdapter(coverageDirectory);
    });
    teardown(async () => {
        // Wait for a second before starting another test (sometimes, sockets take a while to get closed).
        await sleep(1000);
        try {
            await debugClient.stop().catch(() => { });
        } catch (ex) { }
        if (procToKill) {
            try {
                procToKill.kill();
            } catch { }
        }
    });
    async function testAttachingToRemoteProcess(localRoot: string, remoteRoot: string, pathSeparator: string) {
        const port = await getFreePort({ host: 'localhost', port: 3000 });
        const customEnv = { ...process.env };

        // Set the path for PTVSD to be picked up.
        // tslint:disable-next-line:no-string-literal
        customEnv['PYTHONPATH'] = PTVSD_PATH;
        const pythonArgs = ['-m', 'ptvsd', '--server', '--port', `${port}`, '--file', fileToDebug.fileToCommandArgument()];
        procToKill = spawn('python', pythonArgs, { env: customEnv, cwd: path.dirname(fileToDebug) });
        // wait for remote socket to start
        await sleep(1000);

        // Send initialize, attach
        const initializePromise = debugClient.initializeRequest({
            adapterID: 'pythonExperimental',
            linesStartAt1: true,
            columnsStartAt1: true,
            supportsRunInTerminalRequest: true,
            pathFormat: 'path',
            supportsVariableType: true,
            supportsVariablePaging: true
        });
        const options: AttachRequestArguments & DebugConfiguration = {
            name: 'attach',
            request: 'attach',
            localRoot,
            remoteRoot,
            type: 'pythonExperimental',
            port: port,
            host: 'localhost',
            logToFile: true,
            debugOptions: [DebugOptions.RedirectOutput]
        };
        const serviceContainer = TypeMoq.Mock.ofType<IServiceContainer>();
        serviceContainer.setup(c => c.get(IPlatformService, TypeMoq.It.isAny())).returns(() => new PlatformService());
        const configProvider = new PythonV2DebugConfigurationProvider(serviceContainer.object);

        const launchArgs = await configProvider.resolveDebugConfiguration({ index: 0, name: 'root', uri: Uri.file(localRoot) }, options);
        const attachPromise = debugClient.attachRequest(launchArgs);

        await Promise.all([
            initializePromise,
            attachPromise,
            debugClient.waitForEvent('initialized')
        ]);

        await debugClient.configurationDoneRequest();

        const stdOutPromise = debugClient.assertOutput('stdout', 'this is stdout');
        const stdErrPromise = debugClient.assertOutput('stderr', 'this is stderr');

        // Don't use path utils, as we're building the paths manually (mimic windows paths on unix test servers and vice versa).
        const localFileName = `${localRoot}${pathSeparator}${path.basename(fileToDebug)}`;
        const breakpointLocation = { path: localFileName, column: 1, line: 12 };
        const breakpointPromise = debugClient.setBreakpointsRequest({
            lines: [breakpointLocation.line],
            breakpoints: [{ line: breakpointLocation.line, column: breakpointLocation.column }],
            source: { path: breakpointLocation.path }
        });
        const exceptionBreakpointPromise = debugClient.setExceptionBreakpointsRequest({ filters: [] });
        await Promise.all([
            breakpointPromise,
            exceptionBreakpointPromise,
            stdOutPromise, stdErrPromise
        ]);

        await debugClient.assertStoppedLocation('breakpoint', breakpointLocation);

        await Promise.all([
            continueDebugging(debugClient),
            debugClient.assertOutput('stdout', 'this is print'),
            debugClient.waitForEvent('exited'),
            debugClient.waitForEvent('terminated')
        ]);
    }
    test('Confirm we are able to attach to a running program', async function () {
        this.timeout(20000);
        // Lets skip this test on AppVeyor (very flaky on AppVeyor).
        if (IS_APPVEYOR) {
            return;
        }

        await testAttachingToRemoteProcess(path.dirname(fileToDebug), path.dirname(fileToDebug), path.sep);
    });
    test('Confirm localpath translations are done correctly', async function () {
        this.timeout(20000);
        // Lets skip this test on AppVeyor (very flaky on AppVeyor).
        if (IS_APPVEYOR) {
            return;
        }

        const localWorkspace = IS_WINDOWS ? '/home/user/Desktop/project/src' : 'C:\\Project\\src';
        const pathSeparator = IS_WINDOWS ? '\\' : '/';
        await testAttachingToRemoteProcess(localWorkspace, path.dirname(fileToDebug), pathSeparator);
    });
});
