// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { IEncryptedStorage } from '../../../platform/common/application/types';
import { traceInfo } from '../../../platform/logging';
import {
    IAsyncDisposableRegistry,
    IConfigurationService,
    IDisposable,
    IExtensionContext
} from '../../../platform/common/types';
import { IS_REMOTE_NATIVE_TEST, initialize } from '../../initialize.node';
import { startJupyterServer, closeNotebooksAndCleanUpAfterTests, hijackPrompt } from '../notebook/helper.node';
import {
    SecureConnectionValidator,
    UserJupyterServerDisplayName,
    UserJupyterServerUriInput,
    UserJupyterServerUrlProvider,
    getBaseJupyterUrl,
    parseUri
} from '../../../standalone/userJupyterServer/userServerUrlProvider';
import {
    IJupyterRequestAgentCreator,
    IJupyterRequestCreator,
    IJupyterServerProviderRegistry,
    IJupyterServerUriStorage,
    JupyterServerProviderHandle
} from '../../../kernels/jupyter/types';
import { JupyterConnection } from '../../../kernels/jupyter/connection/jupyterConnection';
import { dispose } from '../../../platform/common/utils/lifecycle';
import { anything, instance, mock, when } from 'ts-mockito';
import {
    CancellationTokenSource,
    Disposable,
    EventEmitter,
    InputBox,
    Memento,
    commands,
    env,
    window,
    workspace
} from 'vscode';
import { noop } from '../../../platform/common/utils/misc';
import { DataScience } from '../../../platform/common/utils/localize';
import * as sinon from 'sinon';
import assert from 'assert';
import { createDeferred, createDeferredFromPromise } from '../../../platform/common/utils/async';
import { IMultiStepInputFactory } from '../../../platform/common/utils/multiStepInput';
import { IFileSystem } from '../../../platform/common/platform/types';
import { UserJupyterServerPickerProviderId } from '../../../platform/common/constants';

suite('Connect to Remote Jupyter Servers @mandatory', function () {
    // On conda these take longer for some reason.
    this.timeout(120_000);
    let jupyterNotebookWithAutoGeneratedToken = { url: '', dispose: noop };
    let jupyterLabWithAutoGeneratedToken = { url: '', dispose: noop };
    let jupyterNotebookWithCerts = { url: '', dispose: noop };
    let jupyterNotebookWithHelloPassword = { url: '', dispose: noop };
    let jupyterLabWithHelloPasswordAndWorldToken = { url: '', dispose: noop };
    let jupyterNotebookWithHelloToken = { url: '', dispose: noop };
    let jupyterNotebookWithEmptyPasswordToken = { url: '', dispose: noop };
    let jupyterLabWithHelloPasswordAndEmptyToken = { url: '', dispose: noop };
    suiteSetup(async function () {
        if (!IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }
        this.timeout(120_000);
        await initialize();
        [
            jupyterNotebookWithAutoGeneratedToken,
            jupyterLabWithAutoGeneratedToken,
            jupyterNotebookWithCerts,
            jupyterNotebookWithHelloPassword,
            jupyterLabWithHelloPasswordAndWorldToken,
            jupyterNotebookWithHelloToken,
            jupyterNotebookWithEmptyPasswordToken,
            jupyterLabWithHelloPasswordAndEmptyToken
        ] = await Promise.all([
            startJupyterServer({
                jupyterLab: false,
                standalone: true
            }),
            startJupyterServer({
                jupyterLab: true,
                standalone: true
            }),
            startJupyterServer({
                jupyterLab: false,
                standalone: true,
                useCert: true
            }),
            startJupyterServer({
                jupyterLab: false,
                password: 'Hello',
                standalone: true
            }),
            startJupyterServer({
                jupyterLab: true,
                password: 'Hello',
                token: 'World',
                standalone: true
            }),
            startJupyterServer({
                jupyterLab: false,
                token: 'Hello',
                standalone: true
            }),
            startJupyterServer({
                jupyterLab: false,
                password: '',
                token: '',
                standalone: true
            }),
            startJupyterServer({
                jupyterLab: false,
                password: 'Hello',
                token: '',
                standalone: true
            })
        ]);
    });
    suiteTeardown(() => {
        dispose([
            jupyterNotebookWithAutoGeneratedToken,
            jupyterLabWithAutoGeneratedToken,
            jupyterNotebookWithHelloPassword,
            jupyterLabWithHelloPasswordAndWorldToken,
            jupyterNotebookWithHelloToken,
            jupyterNotebookWithEmptyPasswordToken,
            jupyterLabWithHelloPasswordAndEmptyToken
        ]);
    });
    let encryptedStorage: IEncryptedStorage;
    let memento: Memento;
    const disposables: IDisposable[] = [];
    let userUriProvider: UserJupyterServerUrlProvider;
    let inputBox: InputBox;
    let token: CancellationTokenSource;
    let requestCreator: IJupyterRequestCreator;
    setup(async function () {
        if (!IS_REMOTE_NATIVE_TEST()) {
            return this.skip();
        }
        traceInfo(`Start Test ${this.currentTest?.title}`);
        const api = await initialize();
        inputBox = {
            show: noop,
            onDidAccept: noop as any,
            onDidHide: noop as any,
            hide: noop,
            dispose: noop as any,
            onDidChangeValue: noop as any,
            onDidTriggerButton: noop as any,
            valueSelection: undefined,
            totalSteps: undefined,
            validationMessage: '',
            busy: false,
            buttons: [],
            enabled: true,
            ignoreFocusOut: false,
            password: false,
            step: undefined,
            title: '',
            value: '',
            prompt: '',
            placeholder: ''
        };
        sinon.stub(inputBox, 'show').callsFake(noop);
        sinon.stub(inputBox, 'onDidAccept').callsFake((cb) => {
            cb();
            return new Disposable(noop);
        });
        sinon.stub(inputBox, 'onDidHide').callsFake(() => new Disposable(noop));
        sinon.stub(commands, 'registerCommand').resolves();
        token = new CancellationTokenSource();
        disposables.push(new Disposable(() => token.cancel()));
        disposables.push(token);
        encryptedStorage = mock<IEncryptedStorage>();
        memento = mock<Memento>();
        when(memento.get(anything())).thenReturn(undefined);
        when(memento.get(anything(), anything())).thenCall((_, defaultValue) => defaultValue);
        when(memento.update(anything(), anything())).thenResolve();
        when(encryptedStorage.retrieve(anything(), anything())).thenResolve();
        when(encryptedStorage.store(anything(), anything(), anything())).thenResolve();
        sinon.stub(window, 'createInputBox').callsFake(() => inputBox);
        const serverUriStorage = mock<IJupyterServerUriStorage>();
        when(serverUriStorage.all).thenReturn([]);
        const onDidRemoveUriStorage = new EventEmitter<JupyterServerProviderHandle[]>();
        disposables.push(onDidRemoveUriStorage);
        when(serverUriStorage.onDidRemove).thenReturn(onDidRemoveUriStorage.event);
        requestCreator = api.serviceContainer.get<IJupyterRequestCreator>(IJupyterRequestCreator);

        userUriProvider = new UserJupyterServerUrlProvider(
            api.serviceContainer.get<IConfigurationService>(IConfigurationService),
            api.serviceContainer.get<JupyterConnection>(JupyterConnection),
            instance(encryptedStorage),
            instance(serverUriStorage),
            instance(memento),
            disposables,
            api.serviceContainer.get<IMultiStepInputFactory>(IMultiStepInputFactory),
            api.serviceContainer.get<IAsyncDisposableRegistry>(IAsyncDisposableRegistry),
            api.serviceContainer.get<IJupyterRequestAgentCreator>(IJupyterRequestAgentCreator),
            api.serviceContainer.get<IJupyterRequestCreator>(IJupyterRequestCreator),
            api.serviceContainer.get<IExtensionContext>(IExtensionContext),
            api.serviceContainer.get<IFileSystem>(IFileSystem),
            api.serviceContainer.get<IJupyterServerProviderRegistry>(IJupyterServerProviderRegistry),
            `${UserJupyterServerPickerProviderId}_test` // Give a different Id, as this class is already loaded in extension.
        );
        userUriProvider.activate();

        traceInfo(`Start Test Completed ${this.currentTest?.title}`);
    });

    teardown(async function () {
        traceInfo(`End Test ${this.currentTest?.title}`);
        sinon.restore();
        dispose(disposables);
        traceInfo(`End Test Completed ${this.currentTest?.title}`);
    });
    suiteTeardown(() => closeNotebooksAndCleanUpAfterTests(disposables));

    async function testConnectionAndVerifyBaseUrl({
        password,
        userUri,
        failWithInvalidPassword
    }: {
        password?: string;
        userUri: string;
        failWithInvalidPassword?: boolean;
    }) {
        const config = workspace.getConfiguration('jupyter');
        await config.update('allowUnauthorizedRemoteConnection', false);
        const prompt = await hijackPrompt(
            'showErrorMessage',
            { contains: 'certificate' },
            { result: DataScience.jupyterSelfCertEnable, clickImmediately: true }
        );
        disposables.push(prompt);
        const displayName = 'Test Remove Server Name';
        void env.clipboard.writeText(userUri);
        sinon.stub(UserJupyterServerUriInput.prototype, 'getUrlFromUser').resolves({
            url: userUri,
            jupyterServerUri: parseUri(userUri, '')!
        });
        const baseUrl = `${new URL(userUri).protocol}//localhost:${new URL(userUri).port}/`;
        const computedBaseUrl = await getBaseJupyterUrl(userUri, requestCreator);
        assert.strictEqual(computedBaseUrl?.endsWith('/') ? computedBaseUrl : `${computedBaseUrl}/`, baseUrl);
        sinon.stub(SecureConnectionValidator.prototype, 'promptToUseInsecureConnections').resolves(true);
        sinon.stub(UserJupyterServerDisplayName.prototype, 'getDisplayName').resolves(displayName);
        const errorMessageDisplayed = createDeferred<string>();
        inputBox.value = password || '';
        sinon.stub(inputBox, 'validationMessage').set((msg) => (msg ? errorMessageDisplayed.resolve(msg) : undefined));
        const [cmd] = await userUriProvider.provideCommands(userUri, token.token);
        const handlePromise = createDeferredFromPromise(userUriProvider.handleCommand(cmd, token.token));
        await Promise.race([handlePromise.promise, errorMessageDisplayed.promise]);

        if (failWithInvalidPassword) {
            assert.strictEqual(errorMessageDisplayed.value, DataScience.passwordFailure);
            assert.ok(!handlePromise.completed);
        } else {
            if (new URL(userUri).protocol.includes('https')) {
                assert.ok(await prompt.displayed, 'Prompt for trusting certs not displayed');
            }
            assert.equal(errorMessageDisplayed.value || '', '', `Password should be valid, ${errorMessageDisplayed}`);
            assert.ok(handlePromise.completed, 'Did not complete');
            const value = handlePromise.value;
            if (!value) {
                throw new Error(`Jupyter Server URI not entered, ${value}`);
            }
            assert.ok(value.id, 'Invalid Handle');
            assert.ok(value.label, displayName);

            // Once storage has been refactored, then enable these tests.
            // const { serverHandle, serverInfo } = JSON.parse(
            //     capture(encryptedStorage.store).first()[1] as string
            // )[0] as {
            //     serverHandle: JupyterServerProviderHandle;
            //     serverInfo: IJupyterServerUri;
            // };

            // assert.ok(serverHandle);
            // assert.ok(serverInfo);
            // assert.strictEqual(serverHandle.handle, handlePromise.value, 'Invalid handle');
            // assert.strictEqual(serverHandle.extensionId, JVSC_EXTENSION_ID, 'Invalid Extension Id');
            // assert.strictEqual(
            //     serverInfo.baseUrl,
            //     `http://localhost:${new URL(userUri).port}/`,
            //     'Invalid BaseUrl'
            // );
            // assert.strictEqual(serverInfo.displayName, `Title of Server`, 'Invalid Title');
        }
    }
    test('Connect to server with auto generated Token in URL', () =>
        testConnectionAndVerifyBaseUrl({ userUri: jupyterNotebookWithAutoGeneratedToken.url, password: undefined }));
    test('Connect to JuyterLab server with auto generated Token in URL', () =>
        testConnectionAndVerifyBaseUrl({ userUri: jupyterLabWithAutoGeneratedToken.url, password: undefined }));
    test('Connect to server with certificates', () =>
        testConnectionAndVerifyBaseUrl({ userUri: jupyterNotebookWithCerts.url, password: undefined }));
    test('Connect to server with auto generated Token in URL and path has tree in it', async () => {
        const token = new URL(jupyterNotebookWithAutoGeneratedToken.url).searchParams.get('token')!;
        const port = new URL(jupyterNotebookWithAutoGeneratedToken.url).port;
        await testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${port}/tree?token=${token}`,
            password: undefined
        });
    });
    test('Connect to server with auto generated Token in URL and custom path', async () => {
        const token = new URL(jupyterLabWithAutoGeneratedToken.url).searchParams.get('token')!;
        const port = new URL(jupyterLabWithAutoGeneratedToken.url).port;
        await testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${port}/notebooks/Untitled.ipynb?kernel_name=python3&token=${token}`,
            password: undefined
        });
    });
    test('Connect to Jupyter Lab server with auto generated Token in URL and path has lab in it', async () => {
        const token = new URL(jupyterLabWithAutoGeneratedToken.url).searchParams.get('token')!;
        const port = new URL(jupyterLabWithAutoGeneratedToken.url).port;
        await testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${port}/lab?token=${token}`,
            password: undefined
        });
    });
    test('Connect to Jupyter Lab server with auto generated Token in URL and custom path', async () => {
        const token = new URL(jupyterLabWithAutoGeneratedToken.url).searchParams.get('token')!;
        const port = new URL(jupyterLabWithAutoGeneratedToken.url).port;
        await testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${port}/lab/workspaces/auto-R?token=${token}`,
            password: undefined
        });
    });
    test('Connect to server with Token in URL', () =>
        testConnectionAndVerifyBaseUrl({ userUri: jupyterNotebookWithHelloToken.url, password: undefined }));
    test('Connect to server with Password and Token in URL', () =>
        testConnectionAndVerifyBaseUrl({ userUri: jupyterNotebookWithHelloPassword.url, password: 'Hello' }));
    test('Connect to Notebook server with Password and no Token in URL', () =>
        testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${new URL(jupyterNotebookWithHelloPassword.url).port}/`,
            password: 'Hello'
        }));
    test('Connect to Lab server with Password and no Token in URL', () =>
        testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${new URL(jupyterLabWithHelloPasswordAndWorldToken.url).port}/`,
            password: 'Hello'
        }));
    test('Connect to server with Invalid Password', () =>
        testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${new URL(jupyterNotebookWithHelloPassword.url).port}/`,
            password: 'Bogus',
            failWithInvalidPassword: true
        }));
    test('Connect to Lab server with Password & Token in URL', async () =>
        testConnectionAndVerifyBaseUrl({ userUri: jupyterLabWithHelloPasswordAndWorldToken.url, password: 'Hello' }));
    test('Connect to server with empty Password & empty Token in URL', () =>
        testConnectionAndVerifyBaseUrl({ userUri: jupyterNotebookWithEmptyPasswordToken.url, password: '' }));
    test('Connect to server with empty Password & empty Token (nothing in URL)', () =>
        testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${new URL(jupyterNotebookWithEmptyPasswordToken.url).port}/`,
            password: ''
        }));
    test('Connect to Lab server with Hello Password & empty Token (not even in URL)', () =>
        testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${new URL(jupyterLabWithHelloPasswordAndEmptyToken.url).port}/`,
            password: 'Hello'
        }));
    test('Connect to Lab server with bogus Password & empty Token (not even in URL)', () =>
        testConnectionAndVerifyBaseUrl({
            userUri: `http://localhost:${new URL(jupyterLabWithHelloPasswordAndEmptyToken.url).port}/`,
            password: 'Bogus',
            failWithInvalidPassword: true
        }));
});
