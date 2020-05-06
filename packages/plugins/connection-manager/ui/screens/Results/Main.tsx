import React, { useEffect } from 'react';
import getVscode from '../../lib/vscode';
import { IWebviewMessage } from '../../interfaces';
import logger from '@sqltools/util/log';
import { NSDatabase, IQueryOptions } from '@sqltools/types';
import ViewContainer from './components/ViewContainer';
import Tabs from './components/QueryTabs';
import Table from './components/Table';
import Loading from '../../components/Loading';
import useReducer from './utils/useReducer.base';
import { Button } from '@material-ui/core';
import '@sqltools/plugins/connection-manager/ui/sass/results.scss';
import sendMessage, { messageLog } from '../../lib/messages';
import { QueryResultsState } from './interfaces';
import { MenuActions } from './constants';


const log = logger.extend('results');

interface Props {};

const initialState: QueryResultsState = {
  loading: true,
  error: null,
  resultTabs: [],
  activeTab: 0,
};

enum ACTION {
  RESET = 'RESET',
  RESULTS_RECEIVED = 'RESULTS_RECEIVED',
  TOGGLE_TAB = 'TOGGLE_TAB',
  SET = 'SET',
}

const getCurrentQueryOptions = (activeResult: NSDatabase.IResult) => {
  return {
    requestId: activeResult.requestId,
    resultId: activeResult.resultId,
    baseQuery: activeResult.baseQuery,
    connId: activeResult.connId,
  };
}

function reducer(state: QueryResultsState, action: { type: ACTION, payload?: any }): QueryResultsState {
  switch (action.type) {
    case ACTION.RESET:
      return { ...initialState };
    case ACTION.RESULTS_RECEIVED:
      return { ...state, ...action.payload };
    case ACTION.TOGGLE_TAB:
      return { ...state, activeTab: action.payload };
    case ACTION.SET:
      return { ...state, ...action.payload };
    default:
      throw new Error();
  }
}

const Screen: React.SFC<Props> = () => {
  const [state, dispatch, stateRef] = useReducer(reducer, initialState);
  const {
    loading,
    error,
    resultTabs: results,
    activeTab,
  } = state;

  const getCurrentResult = (s: QueryResultsState) => {
    const { resultTabs: queryResults, activeTab: index } = s || state;
    return queryResults[index] as NSDatabase.IResult;
  }
  const set = (payload: Partial<QueryResultsState>) => dispatch({ type: ACTION.SET, payload });
  const resetRequest = () => dispatch({ type: ACTION.RESULTS_RECEIVED });
  const toggleTab = (value: number) => dispatch({ type: ACTION.TOGGLE_TAB, payload: value });
  const resultsReceived = (changes: Partial<QueryResultsState>) => dispatch({ type: ACTION.RESULTS_RECEIVED, payload: changes });
  const focusMessages = () => sendMessage('call', { command: `${process.env.EXT_NAMESPACE}/consoleMessages.focus` });
  const exportResults = (choice?: MenuActions.SaveCSVOption | MenuActions.SaveJSONOption | any) => {
    const activeResult = getCurrentResult(stateRef.current);
    if (!activeResult) return;
    sendMessage('call', {
      command: `${process.env.EXT_NAMESPACE}.saveResults`,
      args: [{
        ...getCurrentQueryOptions(activeResult),
        fileType: Object.values(MenuActions).includes(choice) ? (choice === MenuActions.SaveJSONOption ? 'json' : 'csv') : undefined,
      }],
    });
    const a = Object.values(MenuActions);
  };
  const reRunQuery = () => {
    const activeResult = getCurrentResult(stateRef.current);
    if (!activeResult) return;
    const { queryType, query, queryParams, pageSize, page } = activeResult;
    if (queryType) {
      sendMessage('call', {
        command: `${process.env.EXT_NAMESPACE}.${queryType}`,
        args: [queryParams, { ...getCurrentQueryOptions(activeResult), page: page, pageSize: pageSize || 50 }],
      });
      return set({ loading: true });
    }
    sendMessage('call', {
      command: `${process.env.EXT_NAMESPACE}.executeQuery`,
      args: [
        query,
        getCurrentQueryOptions(activeResult) as IQueryOptions
      ],
    });
    return set({ loading: true });
  };

  const changePage = (page: number) => {
    set({ loading: true });
    const activeResult = state.resultTabs[activeTab];
    sendMessage('call', {
      command: `${process.env.EXT_NAMESPACE}.${activeResult.queryType}`,
      args: [activeResult.queryParams, { page, pageSize: activeResult.pageSize || 50, requestId: activeResult.requestId }],
    });
  };


  const messagesHandler = ({ action, payload }: IWebviewMessage<any>) => {
    if (!action) return;
    messageLog('received => %s %O', action, payload || 'NO_PAYLOAD');
    switch (action) {
      case 'queryResults':
        const changes: Partial<QueryResultsState> = {
          resultTabs: payload,
          activeTab: 0,
          loading: false,
          error: (payload as NSDatabase.IResult[]).find(r => !!r.error)
        };
        if (changes.error) {
        }
        return resultsReceived(changes);
      case 'reset':
        return resetRequest();
      case 'getState':
        return sendMessage('receivedState', stateRef.current);
      default:
        return log.extend('warn')(`No handler set for %s`, action);
    }
  };

  useEffect(() => {
    // did mount component
    const listener =  ev => messagesHandler(ev.data as IWebviewMessage);
    window.addEventListener('message', listener);
    sendMessage('viewReady', true);
    return () => {
      // cleanup function. onWillUnmount
      window.removeEventListener('message', listener);
    }
  }, []);

  useEffect(() => {
    // did update state. Persist
    getVscode().setState(stateRef.current);
    return () => {
      getVscode().setState(null);
    }
  }, [state, state.resultTabs, state.resultTabs.length]);

  useEffect(() => {
    const { resultTabs: results, activeTab: index } = stateRef.current;
    const activeResult = results[index];
    sendMessage('syncConsoleMessages', (activeResult && activeResult.messages) || []);
  }, [activeTab, state.resultTabs, state.resultTabs.length]);

  useEffect(() => {
    if (error) {
      focusMessages();
    }
  }, [error])

  const activeResult = state.resultTabs[activeTab];
  const pageSize = (activeResult && activeResult.pageSize || 50);
  const showPagination = !activeResult || !activeResult.results || Math.max(activeResult.total || 0, activeResult.results.length) > pageSize;
  const cols = activeResult && activeResult.cols && activeResult.cols.length > 0 ? activeResult.cols : [''];
  const columns = cols.map(title => ({ name: title, title }));

  return (
    <ViewContainer>
      <Tabs active={activeTab} items={results.map(r => r.label || r.query)} onChange={toggleTab}/>
      {activeResult && <Table
        columns={columns}
        rows={activeResult.results || []}
        columnNames={activeResult.cols}
        page={activeResult.page}
        query={activeResult.query}
        queryType={activeResult.queryType}
        queryParams={activeResult.queryParams}
        total={activeResult.total}
        showPagination={showPagination}
        pageSize={pageSize}
        error={error}
        changePage={changePage}
        queryOptions={getCurrentQueryOptions(activeResult)}
        menuActions={{
          [MenuActions.ReRunQueryOption]: reRunQuery,
          [MenuActions.SaveCSVOption]: exportResults,
          [MenuActions.SaveJSONOption]: exportResults,
        }}
        footerButtons={
          <div className='buttons'>
            <Button onClick={focusMessages} className='action-button'>Console</Button>
            <Button onClick={reRunQuery} className='action-button'>Re-Run Query</Button>
            <Button onClick={exportResults} className='action-button'>Export</Button>
          </div>
        }
      />}
      {loading && <Loading active />}
    </ViewContainer>
  );
};
export default Screen;