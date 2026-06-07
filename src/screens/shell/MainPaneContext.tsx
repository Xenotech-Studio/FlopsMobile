/**
 * MainPaneContext —— 把"主区嵌套 navigator 的 navigation 对象"桥接给侧栏（在 navigator 外面）。
 *
 * 侧栏 DrawerContent 在 MainPaneNavigator 外面，拿不到它的 useNavigation；改用一个共享 ref：
 *  - MainPaneNavigator 里每个 wrapper 屏挂载时调 useMainPaneBind() 把自己的 navigation 存进 ref。
 *  - DrawerShell 通过 useMainPaneController() 拿到一组语义化操作（goToday/goProject/goDocs/openChat…），
 *    内部操作那个 ref，从而在主区栈上 reset / push。
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { CommonActions, useFocusEffect } from '@react-navigation/native';
import type { SharedValue } from 'react-native-reanimated';

/** 主区嵌套 navigation 的最小接口（避免到处引 MainPaneNavigation 造成循环依赖） */
export type MainPaneNavRef = {
  dispatch: (action: unknown) => void;
  navigate: (name: string, params?: object) => void;
  setOptions: (options: { gestureEnabled?: boolean }) => void;
};

type BindFn = (nav: MainPaneNavRef) => void;

const BindContext = createContext<BindFn | null>(null);

/** 主区导航控制器：语义化操作，内部驱动嵌套栈。 */
export type MainPaneController = {
  /** 重置主区栈到「今日页」（栈底，清掉上面的 Chat/Project 等） */
  goToday: () => void;
  /** 重置到「文档页」 */
  goDocs: () => void;
  /** 重置到某个「项目页」 */
  goProject: (projectId: string, projectName?: string) => void;
  /** 在主区栈上 push 一个对话（右滑入、可返回）。base 决定栈底是 today 还是当前 */
  openChat: (params: {
    conversationId?: string;
    conversationTitle?: string;
    createEncrypted?: boolean;
  }) => void;
  /** 临时开关主区当前屏的返回手势（swipe-back）。拖手柄开侧栏时先关、松手再开，
   *  避免左缘手柄拖动被返回手势抢走。 */
  setSwipeBackEnabled: (enabled: boolean) => void;
};

const ControllerContext = createContext<MainPaneController | null>(null);

/** 当前主区是否停在「二级页」（对话等 push 出来的页，主区左上角是返回键、没汉堡）。
 *  一级页（Today/Project/Docs）= false。分界线切换钮只在 true 时显示。 */
const SecondaryContext = createContext<boolean>(false);
/** 报告"是否二级页"的 setter（仅 Provider 内用） */
const SecondarySetterContext = createContext<((v: boolean) => void) | null>(null);

/** 各路由 wrapper 屏在 focus 时调用，声明自己是不是二级页。
 *  Today/Project/Docs 传 false；Chat（push 出来的对话）传 true。 */
export function useReportMainPaneSecondary(isSecondary: boolean) {
  const setter = useContext(SecondarySetterContext);
  useFocusEffect(
    useCallback(() => {
      setter?.(isSecondary);
    }, [setter, isSecondary]),
  );
}

/** 全局侧栏是否打开（DrawerShell 下发 → 文档页判断分界手柄显隐）。 */
const GlobalSidebarOpenContext = createContext<boolean>(false);
export function useGlobalSidebarOpen(): boolean {
  return useContext(GlobalSidebarOpenContext);
}

/** 全局侧栏「跟手驱动」通道（DrawerShell 下发 → 文档页可在目录树侧栏上横向拖动直接开合全局侧栏）。
 *  animWidth = 全局侧栏当前宽度 SharedValue（UI 线程逐帧写即跟手）；width = 满开宽；
 *  settleOpen = 落位后把 React 逻辑态同步回 DrawerShell。compact / 非 sidebarShell 下为 null。 */
export type GlobalSidebarDrive = {
  animWidth: SharedValue<number>;
  width: number;
  settleOpen: (open: boolean) => void;
};
const GlobalSidebarDriveContext = createContext<GlobalSidebarDrive | null>(null);
export function useGlobalSidebarDrive(): GlobalSidebarDrive | null {
  return useContext(GlobalSidebarDriveContext);
}

/** 文档目录树侧栏开关态（DocsScreen 上报 → DrawerShell 判断全局手柄显隐）。null = 不在文档页。 */
const DocsTreeOpenContext = createContext<boolean | null>(null);
const DocsTreeSetterContext = createContext<((v: boolean | null) => void) | null>(
  null,
);
export function useMainPaneDocsTreeOpen(): boolean | null {
  return useContext(DocsTreeOpenContext);
}
/** 文档页用：上报目录树开关态;卸载/离开文档页时回 null。 */
export function useReportDocsTreeOpen(open: boolean | null) {
  const setter = useContext(DocsTreeSetterContext);
  useEffect(() => {
    setter?.(open);
    return () => setter?.(null);
  }, [setter, open]);
}

/** Provider：DrawerShell 在 sidebarShell 分支包住主区 + 侧栏，统一提供 bind + controller。 */
export function MainPaneProvider({
  children,
  globalSidebarOpen,
  globalSidebarAnimWidth,
  globalSidebarWidth,
  settleGlobalSidebarOpen,
}: {
  children: React.ReactNode;
  /** 全局侧栏当前是否打开（DrawerShell 传入 → 下发给文档页）。 */
  globalSidebarOpen: boolean;
  /** 全局侧栏当前宽度 SharedValue（DrawerShell 的 sidebarAnimWidth）→ 文档页跟手驱动用。 */
  globalSidebarAnimWidth: SharedValue<number>;
  /** 全局侧栏满开宽（DrawerShell 的 sidebarWidth）。 */
  globalSidebarWidth: number;
  /** 跟手落位后把全局侧栏逻辑态同步回 DrawerShell（= setSidebarOpen）。 */
  settleGlobalSidebarOpen: (open: boolean) => void;
}) {
  const navRef = useRef<MainPaneNavRef | null>(null);
  const [isSecondary, setIsSecondary] = useState(false);
  const [docsTreeOpen, setDocsTreeOpen] = useState<boolean | null>(null);

  const bind = useCallback<BindFn>((nav) => {
    navRef.current = nav;
  }, []);

  /** 全局侧栏跟手驱动通道（对象 memo 稳定，避免无谓重渲染）。 */
  const globalSidebarDrive = useMemo<GlobalSidebarDrive>(
    () => ({
      animWidth: globalSidebarAnimWidth,
      width: globalSidebarWidth,
      settleOpen: settleGlobalSidebarOpen,
    }),
    [globalSidebarAnimWidth, globalSidebarWidth, settleGlobalSidebarOpen],
  );

  const controller = useMemo<MainPaneController>(
    () => ({
      goToday: () => {
        navRef.current?.dispatch(
          CommonActions.reset({ index: 0, routes: [{ name: 'Today' }] }),
        );
      },
      goDocs: () => {
        navRef.current?.dispatch(
          CommonActions.reset({ index: 0, routes: [{ name: 'Docs' }] }),
        );
      },
      goProject: (projectId, projectName) => {
        navRef.current?.dispatch(
          CommonActions.reset({
            index: 0,
            routes: [{ name: 'Project', params: { projectId, projectName } }],
          }),
        );
      },
      openChat: (params) => {
        /* iPad：对话也是顶级页——reset 成单条 [Chat] 栈（跟 goToday/goDocs 一样），
         *  直接切入、不滑入，左上角是汉堡（侧栏常驻，靠侧栏切换而非返回箭头）。 */
        navRef.current?.dispatch(
          CommonActions.reset({ index: 0, routes: [{ name: 'Chat', params }] }),
        );
      },
      setSwipeBackEnabled: (enabled) => {
        navRef.current?.setOptions({ gestureEnabled: enabled });
      },
    }),
    [],
  );

  return (
    <BindContext.Provider value={bind}>
      <ControllerContext.Provider value={controller}>
        <GlobalSidebarOpenContext.Provider value={globalSidebarOpen}>
          <GlobalSidebarDriveContext.Provider value={globalSidebarDrive}>
            <DocsTreeSetterContext.Provider value={setDocsTreeOpen}>
              <DocsTreeOpenContext.Provider value={docsTreeOpen}>
                <SecondarySetterContext.Provider value={setIsSecondary}>
                  <SecondaryContext.Provider value={isSecondary}>
                    {children}
                  </SecondaryContext.Provider>
                </SecondarySetterContext.Provider>
              </DocsTreeOpenContext.Provider>
            </DocsTreeSetterContext.Provider>
          </GlobalSidebarDriveContext.Provider>
        </GlobalSidebarOpenContext.Provider>
      </ControllerContext.Provider>
    </BindContext.Provider>
  );
}

/** DrawerShell 读：当前主区是否二级页（决定分界线切换钮是否显示）。 */
export function useMainPaneIsSecondary(): boolean {
  return useContext(SecondaryContext);
}

export function useMainPaneBind(): BindFn {
  const v = useContext(BindContext);
  if (!v) throw new Error('useMainPaneBind must be used inside <MainPaneProvider>');
  return v;
}

/** 返回 controller；不在 Provider 内（compact 模式）时返回 null。 */
export function useMainPaneController(): MainPaneController | null {
  return useContext(ControllerContext);
}
