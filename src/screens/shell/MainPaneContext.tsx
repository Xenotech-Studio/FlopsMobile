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
  useMemo,
  useRef,
  useState,
} from 'react';
import { CommonActions, useFocusEffect } from '@react-navigation/native';

/** 主区嵌套 navigation 的最小接口（避免到处引 MainPaneNavigation 造成循环依赖） */
export type MainPaneNavRef = {
  dispatch: (action: unknown) => void;
  navigate: (name: string, params?: object) => void;
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

/** Provider：DrawerShell 在 sidebarShell 分支包住主区 + 侧栏，统一提供 bind + controller。 */
export function MainPaneProvider({ children }: { children: React.ReactNode }) {
  const navRef = useRef<MainPaneNavRef | null>(null);
  const [isSecondary, setIsSecondary] = useState(false);

  const bind = useCallback<BindFn>((nav) => {
    navRef.current = nav;
  }, []);

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
        /* 重置到「今日页 + 对话」两层：返回箭头回到今日页，栈结构统一。
         *  （新对话用 nonce 体现在 key 上由屏内部处理；这里 reset 保证每次进对话栈干净。） */
        navRef.current?.dispatch(
          CommonActions.reset({
            index: 1,
            routes: [
              { name: 'Today' },
              { name: 'Chat', params },
            ],
          }),
        );
      },
    }),
    [],
  );

  return (
    <BindContext.Provider value={bind}>
      <ControllerContext.Provider value={controller}>
        <SecondarySetterContext.Provider value={setIsSecondary}>
          <SecondaryContext.Provider value={isSecondary}>
            {children}
          </SecondaryContext.Provider>
        </SecondarySetterContext.Provider>
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
