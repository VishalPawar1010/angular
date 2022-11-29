/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Location} from '@angular/common';
import {inject, Injectable, NgModuleRef, Type} from '@angular/core';
import {BehaviorSubject, combineLatest, EMPTY, Observable, of, Subject} from 'rxjs';
import {catchError, defaultIfEmpty, filter, finalize, map, switchMap, take, tap} from 'rxjs/operators';

import {createRouterState} from './create_router_state';
import {Event, GuardsCheckEnd, GuardsCheckStart, NavigationCancel, NavigationCancellationCode, NavigationEnd, NavigationError, NavigationStart, NavigationTrigger, ResolveEnd, ResolveStart, RouteConfigLoadEnd, RouteConfigLoadStart, RoutesRecognized} from './events';
import {NavigationBehaviorOptions, QueryParamsHandling, Route, Routes} from './models';
import {isNavigationCancelingError, isRedirectingNavigationCancelingError, redirectingNavigationError} from './navigation_canceling_error';
import {activateRoutes} from './operators/activate_routes';
import {applyRedirects} from './operators/apply_redirects';
import {checkGuards} from './operators/check_guards';
import {recognize} from './operators/recognize';
import {resolveData} from './operators/resolve_data';
import {switchTap} from './operators/switch_tap';
import {TitleStrategy} from './page_title_strategy';
import {RouteReuseStrategy} from './route_reuse_strategy';
import {ErrorHandler} from './router_config';
import {RouterConfigLoader} from './router_config_loader';
import {ChildrenOutletContexts} from './router_outlet_context';
import {ActivatedRoute, ActivatedRouteSnapshot, createEmptyState, RouterState, RouterStateSnapshot} from './router_state';
import {Params} from './shared';
import {UrlHandlingStrategy} from './url_handling_strategy';
import {isUrlTree, UrlSerializer, UrlTree} from './url_tree';
import {Checks, getAllRouteGuards} from './utils/preactivation';


const NG_DEV_MODE = typeof ngDevMode === 'undefined' || !!ngDevMode;

/**
 * @description
 *
 * Options that modify the `Router` URL.
 * Supply an object containing any of these properties to a `Router` navigation function to
 * control how the target URL should be constructed.
 *
 * @see [Router.navigate() method](api/router/Router#navigate)
 * @see [Router.createUrlTree() method](api/router/Router#createurltree)
 * @see [Routing and Navigation guide](guide/router)
 *
 * @publicApi
 */
export interface UrlCreationOptions {
  /**
   * Specifies a root URI to use for relative navigation.
   *
   * For example, consider the following route configuration where the parent route
   * has two children.
   *
   * ```
   * [{
   *   path: 'parent',
   *   component: ParentComponent,
   *   children: [{
   *     path: 'list',
   *     component: ListComponent
   *   },{
   *     path: 'child',
   *     component: ChildComponent
   *   }]
   * }]
   * ```
   *
   * The following `go()` function navigates to the `list` route by
   * interpreting the destination URI as relative to the activated `child`  route
   *
   * ```
   *  @Component({...})
   *  class ChildComponent {
   *    constructor(private router: Router, private route: ActivatedRoute) {}
   *
   *    go() {
   *      router.navigate(['../list'], { relativeTo: this.route });
   *    }
   *  }
   * ```
   *
   * A value of `null` or `undefined` indicates that the navigation commands should be applied
   * relative to the root.
   */
  relativeTo?: ActivatedRoute|null;

  /**
   * Sets query parameters to the URL.
   *
   * ```
   * // Navigate to /results?page=1
   * router.navigate(['/results'], { queryParams: { page: 1 } });
   * ```
   */
  queryParams?: Params|null;

  /**
   * Sets the hash fragment for the URL.
   *
   * ```
   * // Navigate to /results#top
   * router.navigate(['/results'], { fragment: 'top' });
   * ```
   */
  fragment?: string;

  /**
   * How to handle query parameters in the router link for the next navigation.
   * One of:
   * * `preserve` : Preserve current parameters.
   * * `merge` : Merge new with current parameters.
   *
   * The "preserve" option discards any new query params:
   * ```
   * // from /view1?page=1 to/view2?page=1
   * router.navigate(['/view2'], { queryParams: { page: 2 },  queryParamsHandling: "preserve"
   * });
   * ```
   * The "merge" option appends new query params to the params from the current URL:
   * ```
   * // from /view1?page=1 to/view2?page=1&otherKey=2
   * router.navigate(['/view2'], { queryParams: { otherKey: 2 },  queryParamsHandling: "merge"
   * });
   * ```
   * In case of a key collision between current parameters and those in the `queryParams` object,
   * the new value is used.
   *
   */
  queryParamsHandling?: QueryParamsHandling|null;

  /**
   * When true, preserves the URL fragment for the next navigation
   *
   * ```
   * // Preserve fragment from /results#top to /view#top
   * router.navigate(['/view'], { preserveFragment: true });
   * ```
   */
  preserveFragment?: boolean;
}

/**
 * @description
 *
 * Options that modify the `Router` navigation strategy.
 * Supply an object containing any of these properties to a `Router` navigation function to
 * control how the target URL should be constructed or interpreted.
 *
 * @see [Router.navigate() method](api/router/Router#navigate)
 * @see [Router.navigateByUrl() method](api/router/Router#navigatebyurl)
 * @see [Router.createUrlTree() method](api/router/Router#createurltree)
 * @see [Routing and Navigation guide](guide/router)
 * @see UrlCreationOptions
 * @see NavigationBehaviorOptions
 *
 * @publicApi
 */
export interface NavigationExtras extends UrlCreationOptions, NavigationBehaviorOptions {}

export type RestoredState = {
  [k: string]: any,
  // TODO(#27607): Remove `navigationId` and `ɵrouterPageId` and move to `ng` or `ɵ` namespace.
  navigationId: number,
  // The `ɵ` prefix is there to reduce the chance of colliding with any existing user properties on
  // the history state.
  ɵrouterPageId?: number,
};

/**
 * Information about a navigation operation.
 * Retrieve the most recent navigation object with the
 * [Router.getCurrentNavigation() method](api/router/Router#getcurrentnavigation) .
 *
 * * *id* : The unique identifier of the current navigation.
 * * *initialUrl* : The target URL passed into the `Router#navigateByUrl()` call before navigation.
 * This is the value before the router has parsed or applied redirects to it.
 * * *extractedUrl* : The initial target URL after being parsed with `UrlSerializer.extract()`.
 * * *finalUrl* : The extracted URL after redirects have been applied.
 * This URL may not be available immediately, therefore this property can be `undefined`.
 * It is guaranteed to be set after the `RoutesRecognized` event fires.
 * * *trigger* : Identifies how this navigation was triggered.
 * -- 'imperative'--Triggered by `router.navigateByUrl` or `router.navigate`.
 * -- 'popstate'--Triggered by a popstate event.
 * -- 'hashchange'--Triggered by a hashchange event.
 * * *extras* : A `NavigationExtras` options object that controlled the strategy used for this
 * navigation.
 * * *previousNavigation* : The previously successful `Navigation` object. Only one previous
 * navigation is available, therefore this previous `Navigation` object has a `null` value for its
 * own `previousNavigation`.
 *
 * @publicApi
 */
export interface Navigation {
  /**
   * The unique identifier of the current navigation.
   */
  id: number;
  /**
   * The target URL passed into the `Router#navigateByUrl()` call before navigation. This is
   * the value before the router has parsed or applied redirects to it.
   */
  initialUrl: UrlTree;
  /**
   * The initial target URL after being parsed with `UrlHandlingStrategy.extract()`.
   */
  extractedUrl: UrlTree;
  /**
   * The extracted URL after redirects have been applied.
   * This URL may not be available immediately, therefore this property can be `undefined`.
   * It is guaranteed to be set after the `RoutesRecognized` event fires.
   */
  finalUrl?: UrlTree;
  /**
   * Identifies how this navigation was triggered.
   *
   * * 'imperative'--Triggered by `router.navigateByUrl` or `router.navigate`.
   * * 'popstate'--Triggered by a popstate event.
   * * 'hashchange'--Triggered by a hashchange event.
   */
  trigger: 'imperative'|'popstate'|'hashchange';
  /**
   * Options that controlled the strategy used for this navigation.
   * See `NavigationExtras`.
   */
  extras: NavigationExtras;
  /**
   * The previously successful `Navigation` object. Only one previous navigation
   * is available, therefore this previous `Navigation` object has a `null` value
   * for its own `previousNavigation`.
   */
  previousNavigation: Navigation|null;
}

export interface NavigationTransition {
  id: number;
  targetPageId: number;
  currentUrlTree: UrlTree;
  extractedUrl: UrlTree;
  urlAfterRedirects?: UrlTree;
  rawUrl: UrlTree;
  extras: NavigationExtras;
  resolve: any;
  reject: any;
  promise: Promise<boolean>;
  source: NavigationTrigger;
  restoredState: RestoredState|null;
  currentSnapshot: RouterStateSnapshot;
  targetSnapshot: RouterStateSnapshot|null;
  currentRouterState: RouterState;
  targetRouterState: RouterState|null;
  guards: Checks;
  guardsResult: boolean|UrlTree|null;
}

/**
 * The interface from the Router needed by the transitions. Used to avoid a circular dependency on
 * Router. This interface should be whittled down with future refactors. For example, we do not need
 * to get `UrlSerializer` from the Router. We can instead inject it in `NavigationTransitions`
 * directly.
 */
interface InternalRouterInterface {
  browserUrlTree: UrlTree;
  currentUrlTree: UrlTree;
  rawUrlTree: UrlTree;
  transitions: BehaviorSubject<NavigationTransition>;
  navigationId: number;
  ngModule: NgModuleRef<any>;
  readonly routerState: RouterState;
  errorHandler: ErrorHandler;
  titleStrategy?: TitleStrategy;
  navigated: boolean;
  afterPreactivation: () => Observable<void>;
  urlHandlingStrategy: UrlHandlingStrategy;
  routeReuseStrategy: RouteReuseStrategy;
  onSameUrlNavigation: 'reload'|'ignore';
  paramsInheritanceStrategy: 'emptyOnly'|'always';
  urlUpdateStrategy: 'deferred'|'eager';
  serializeUrl(url: UrlTree): string;
  config: Routes;
  rootComponentType: Type<any>|null;
  urlSerializer: UrlSerializer;
  rootContexts: ChildrenOutletContexts;
  location: Location;
  setBrowserUrl(url: UrlTree, t: NavigationTransition): void;
  restoreHistory(t: NavigationTransition, restoringFromCaughtError?: boolean): void;
  scheduleNavigation(
      rawUrl: UrlTree, source: NavigationTrigger, restoredState: RestoredState|null,
      extras: NavigationExtras,
      priorPromise?: {resolve: any, reject: any, promise: Promise<boolean>}): Promise<boolean>;
}

@Injectable({providedIn: 'root'})
export class NavigationTransitions {
  currentNavigation: Navigation|null = null;
  lastSuccessfulNavigation: Navigation|null = null;
  readonly events = new Subject<Event>();
  private readonly configLoader = inject(RouterConfigLoader);

  constructor() {
    const onLoadStart = (r: Route) => this.events.next(new RouteConfigLoadStart(r));
    const onLoadEnd = (r: Route) => this.events.next(new RouteConfigLoadEnd(r));
    this.configLoader.onLoadEndListener = onLoadEnd;
    this.configLoader.onLoadStartListener = onLoadStart;
  }

  setupNavigations(transitions: Observable<NavigationTransition>, router: InternalRouterInterface):
      Observable<NavigationTransition> {
    return transitions.pipe(
               filter(t => t.id !== 0),

               // Extract URL
               map(t =>
                       ({...t, extractedUrl: router.urlHandlingStrategy.extract(t.rawUrl)} as
                        NavigationTransition)),

               // Using switchMap so we cancel executing navigations when a new one comes in
               switchMap(overallTransitionState => {
                 let completed = false;
                 let errored = false;
                 return of(overallTransitionState)
                     .pipe(
                         // Store the Navigation object
                         tap(t => {
                           this.currentNavigation = {
                             id: t.id,
                             initialUrl: t.rawUrl,
                             extractedUrl: t.extractedUrl,
                             trigger: t.source,
                             extras: t.extras,
                             previousNavigation: !this.lastSuccessfulNavigation ? null : {
                               ...this.lastSuccessfulNavigation,
                               previousNavigation: null,
                             },
                           };
                         }),
                         switchMap(t => {
                           const browserUrlTree = router.browserUrlTree.toString();
                           const urlTransition = !router.navigated ||
                               t.extractedUrl.toString() !== browserUrlTree ||
                               // Navigations which succeed or ones which fail and are cleaned up
                               // correctly should result in `browserUrlTree` and `currentUrlTree`
                               // matching. If this is not the case, assume something went wrong and
                               // try processing the URL again.
                               browserUrlTree !== router.currentUrlTree.toString();
                           const processCurrentUrl =
                               (router.onSameUrlNavigation === 'reload' ? true : urlTransition) &&
                               router.urlHandlingStrategy.shouldProcessUrl(t.rawUrl);


                           if (processCurrentUrl) {
                             // If the source of the navigation is from a browser event, the URL is
                             // already updated. We already need to sync the internal state.
                             if (isBrowserTriggeredNavigation(t.source)) {
                               router.browserUrlTree = t.extractedUrl;
                             }
                             return of(t).pipe(
                                 // Fire NavigationStart event
                                 switchMap(t => {
                                   const transition = router.transitions.getValue();
                                   this.events.next(new NavigationStart(
                                       t.id, router.serializeUrl(t.extractedUrl), t.source,
                                       t.restoredState));
                                   if (transition !== router.transitions.getValue()) {
                                     return EMPTY;
                                   }

                                   // This delay is required to match old behavior that forced
                                   // navigation to always be async
                                   return Promise.resolve(t);
                                 }),

                                 // ApplyRedirects
                                 applyRedirects(
                                     router.ngModule.injector, this.configLoader,
                                     router.urlSerializer, router.config),

                                 // Update the currentNavigation
                                 // `urlAfterRedirects` is guaranteed to be set after this point
                                 tap(t => {
                                   this.currentNavigation = {
                                     ...this.currentNavigation!,
                                     finalUrl: t.urlAfterRedirects
                                   };
                                   overallTransitionState.urlAfterRedirects = t.urlAfterRedirects;
                                 }),

                                 // Recognize
                                 recognize(
                                     router.ngModule.injector, router.rootComponentType,
                                     router.config, router.urlSerializer,
                                     router.paramsInheritanceStrategy),

                                 // Update URL if in `eager` update mode
                                 tap(t => {
                                   overallTransitionState.targetSnapshot = t.targetSnapshot;
                                   if (router.urlUpdateStrategy === 'eager') {
                                     if (!t.extras.skipLocationChange) {
                                       const rawUrl = router.urlHandlingStrategy.merge(
                                           t.urlAfterRedirects!, t.rawUrl);
                                       router.setBrowserUrl(rawUrl, t);
                                     }
                                     router.browserUrlTree = t.urlAfterRedirects!;
                                   }

                                   // Fire RoutesRecognized
                                   const routesRecognized = new RoutesRecognized(
                                       t.id, router.serializeUrl(t.extractedUrl),
                                       router.serializeUrl(t.urlAfterRedirects!),
                                       t.targetSnapshot!);
                                   this.events.next(routesRecognized);
                                 }));
                           } else {
                             const processPreviousUrl = urlTransition && router.rawUrlTree &&
                                 router.urlHandlingStrategy.shouldProcessUrl(router.rawUrlTree);
                             /* When the current URL shouldn't be processed, but the previous one
                              * was, we handle this "error condition" by navigating to the
                              * previously successful URL, but leaving the URL intact.*/
                             if (processPreviousUrl) {
                               const {id, extractedUrl, source, restoredState, extras} = t;
                               const navStart = new NavigationStart(
                                   id, router.serializeUrl(extractedUrl), source, restoredState);
                               this.events.next(navStart);
                               const targetSnapshot =
                                   createEmptyState(extractedUrl, router.rootComponentType)
                                       .snapshot;

                               overallTransitionState = {
                                 ...t,
                                 targetSnapshot,
                                 urlAfterRedirects: extractedUrl,
                                 extras: {...extras, skipLocationChange: false, replaceUrl: false},
                               };
                               return of(overallTransitionState);
                             } else {
                               /* When neither the current or previous URL can be processed, do
                                * nothing other than update router's internal reference to the
                                * current "settled" URL. This way the next navigation will be coming
                                * from the current URL in the browser.
                                */
                               router.rawUrlTree = t.rawUrl;
                               t.resolve(null);
                               return EMPTY;
                             }
                           }
                         }),

                         // --- GUARDS ---
                         tap(t => {
                           const guardsStart = new GuardsCheckStart(
                               t.id, router.serializeUrl(t.extractedUrl),
                               router.serializeUrl(t.urlAfterRedirects!), t.targetSnapshot!);
                           this.events.next(guardsStart);
                         }),

                         map(t => {
                           overallTransitionState = {
                             ...t,
                             guards: getAllRouteGuards(
                                 t.targetSnapshot!, t.currentSnapshot, router.rootContexts)
                           };
                           return overallTransitionState;
                         }),

                         checkGuards(
                             router.ngModule.injector, (evt: Event) => this.events.next(evt)),
                         tap(t => {
                           overallTransitionState.guardsResult = t.guardsResult;
                           if (isUrlTree(t.guardsResult)) {
                             throw redirectingNavigationError(router.urlSerializer, t.guardsResult);
                           }

                           const guardsEnd = new GuardsCheckEnd(
                               t.id, router.serializeUrl(t.extractedUrl),
                               router.serializeUrl(t.urlAfterRedirects!), t.targetSnapshot!,
                               !!t.guardsResult);
                           this.events.next(guardsEnd);
                         }),

                         filter(t => {
                           if (!t.guardsResult) {
                             router.restoreHistory(t);
                             this.cancelNavigationTransition(
                                 t, '', NavigationCancellationCode.GuardRejected, router);
                             return false;
                           }
                           return true;
                         }),

                         // --- RESOLVE ---
                         switchTap(t => {
                           if (t.guards.canActivateChecks.length) {
                             return of(t).pipe(
                                 tap(t => {
                                   const resolveStart = new ResolveStart(
                                       t.id, router.serializeUrl(t.extractedUrl),
                                       router.serializeUrl(t.urlAfterRedirects!),
                                       t.targetSnapshot!);
                                   this.events.next(resolveStart);
                                 }),
                                 switchMap(t => {
                                   let dataResolved = false;
                                   return of(t).pipe(
                                       resolveData(
                                           router.paramsInheritanceStrategy,
                                           router.ngModule.injector),
                                       tap({
                                         next: () => dataResolved = true,
                                         complete: () => {
                                           if (!dataResolved) {
                                             router.restoreHistory(t);
                                             this.cancelNavigationTransition(
                                                 t,
                                                 NG_DEV_MODE ?
                                                     `At least one route resolver didn't emit any value.` :
                                                     '',
                                                 NavigationCancellationCode.NoDataFromResolver,
                                                 router);
                                           }
                                         }
                                       }),
                                   );
                                 }),
                                 tap(t => {
                                   const resolveEnd = new ResolveEnd(
                                       t.id, router.serializeUrl(t.extractedUrl),
                                       router.serializeUrl(t.urlAfterRedirects!),
                                       t.targetSnapshot!);
                                   this.events.next(resolveEnd);
                                 }));
                           }
                           return undefined;
                         }),

                         // --- LOAD COMPONENTS ---
                         switchTap((t: NavigationTransition) => {
                           const loadComponents =
                               (route: ActivatedRouteSnapshot): Array<Observable<void>> => {
                                 const loaders: Array<Observable<void>> = [];
                                 if (route.routeConfig?.loadComponent &&
                                     !route.routeConfig._loadedComponent) {
                                   loaders.push(this.configLoader.loadComponent(route.routeConfig)
                                                    .pipe(
                                                        tap(loadedComponent => {
                                                          route.component = loadedComponent;
                                                        }),
                                                        map(() => void 0),
                                                        ));
                                 }
                                 for (const child of route.children) {
                                   loaders.push(...loadComponents(child));
                                 }
                                 return loaders;
                               };
                           return combineLatest(loadComponents(t.targetSnapshot!.root))
                               .pipe(defaultIfEmpty(), take(1));
                         }),

                         switchTap(() => router.afterPreactivation()),

                         map((t: NavigationTransition) => {
                           const targetRouterState = createRouterState(
                               router.routeReuseStrategy, t.targetSnapshot!, t.currentRouterState);
                           overallTransitionState = {...t, targetRouterState};
                           return (overallTransitionState);
                         }),

                         /* Once here, we are about to activate synchronously. The assumption is
                            this will succeed, and user code may read from the Router service.
                            Therefore before activation, we need to update router properties storing
                            the current URL and the RouterState, as well as updated the browser URL.
                            All this should happen *before* activating. */
                         tap((t: NavigationTransition) => {
                           router.currentUrlTree = t.urlAfterRedirects!;
                           router.rawUrlTree =
                               router.urlHandlingStrategy.merge(t.urlAfterRedirects!, t.rawUrl);

                           (router as {routerState: RouterState}).routerState =
                               t.targetRouterState!;

                           if (router.urlUpdateStrategy === 'deferred') {
                             if (!t.extras.skipLocationChange) {
                               router.setBrowserUrl(router.rawUrlTree, t);
                             }
                             router.browserUrlTree = t.urlAfterRedirects!;
                           }
                         }),

                         activateRoutes(
                             router.rootContexts, router.routeReuseStrategy,
                             (evt: Event) => this.events.next(evt)),

                         tap({
                           next: (t: NavigationTransition) => {
                             completed = true;
                             this.lastSuccessfulNavigation = this.currentNavigation;
                             router.navigated = true;
                             this.events.next(new NavigationEnd(
                                 t.id, router.serializeUrl(t.extractedUrl),
                                 router.serializeUrl(router.currentUrlTree)));
                             router.titleStrategy?.updateTitle(t.targetRouterState!.snapshot);
                             t.resolve(true);
                           },
                           complete: () => {
                             completed = true;
                           }
                         }),
                         finalize(() => {
                           /* When the navigation stream finishes either through error or success,
                            * we set the `completed` or `errored` flag. However, there are some
                            * situations where we could get here without either of those being set.
                            * For instance, a redirect during NavigationStart. Therefore, this is a
                            * catch-all to make sure the NavigationCancel event is fired when a
                            * navigation gets cancelled but not caught by other means. */
                           if (!completed && !errored) {
                             const cancelationReason = NG_DEV_MODE ?
                                 `Navigation ID ${
                                     overallTransitionState
                                         .id} is not equal to the current navigation id ${
                                     router.navigationId}` :
                                 '';
                             this.cancelNavigationTransition(
                                 overallTransitionState, cancelationReason,
                                 NavigationCancellationCode.SupersededByNewNavigation, router);
                           }
                           // Only clear current navigation if it is still set to the one that
                           // finalized.
                           if (this.currentNavigation?.id === overallTransitionState.id) {
                             this.currentNavigation = null;
                           }
                         }),
                         catchError((e) => {
                           errored = true;
                           /* This error type is issued during Redirect, and is handled as a
                            * cancellation rather than an error. */
                           if (isNavigationCancelingError(e)) {
                             if (!isRedirectingNavigationCancelingError(e)) {
                               // Set property only if we're not redirecting. If we landed on a page
                               // and redirect to `/` route, the new navigation is going to see the
                               // `/` isn't a change from the default currentUrlTree and won't
                               // navigate. This is only applicable with initial navigation, so
                               // setting `navigated` only when not redirecting resolves this
                               // scenario.
                               router.navigated = true;
                               router.restoreHistory(overallTransitionState, true);
                             }
                             const navCancel = new NavigationCancel(
                                 overallTransitionState.id,
                                 router.serializeUrl(overallTransitionState.extractedUrl),
                                 e.message, e.cancellationCode);
                             this.events.next(navCancel);

                             // When redirecting, we need to delay resolving the navigation
                             // promise and push it to the redirect navigation
                             if (!isRedirectingNavigationCancelingError(e)) {
                               overallTransitionState.resolve(false);
                             } else {
                               const mergedTree =
                                   router.urlHandlingStrategy.merge(e.url, router.rawUrlTree);
                               const extras = {
                                 skipLocationChange:
                                     overallTransitionState.extras.skipLocationChange,
                                 // The URL is already updated at this point if we have 'eager' URL
                                 // updates or if the navigation was triggered by the browser (back
                                 // button, URL bar, etc). We want to replace that item in history
                                 // if the navigation is rejected.
                                 replaceUrl: router.urlUpdateStrategy === 'eager' ||
                                     isBrowserTriggeredNavigation(overallTransitionState.source)
                               };

                               router.scheduleNavigation(mergedTree, 'imperative', null, extras, {
                                 resolve: overallTransitionState.resolve,
                                 reject: overallTransitionState.reject,
                                 promise: overallTransitionState.promise
                               });
                             }

                             /* All other errors should reset to the router's internal URL reference
                              * to the pre-error state. */
                           } else {
                             router.restoreHistory(overallTransitionState, true);
                             const navError = new NavigationError(
                                 overallTransitionState.id,
                                 router.serializeUrl(overallTransitionState.extractedUrl), e,
                                 overallTransitionState.targetSnapshot ?? undefined);
                             this.events.next(navError);
                             try {
                               overallTransitionState.resolve(router.errorHandler(e));
                             } catch (ee) {
                               overallTransitionState.reject(ee);
                             }
                           }
                           return EMPTY;
                         }));
                 // TODO(jasonaden): remove cast once g3 is on updated TypeScript
               })) as any as Observable<NavigationTransition>;
  }

  private cancelNavigationTransition(
      t: NavigationTransition, reason: string, code: NavigationCancellationCode,
      router: InternalRouterInterface) {
    const navCancel = new NavigationCancel(t.id, router.serializeUrl(t.extractedUrl), reason, code);
    this.events.next(navCancel);
    t.resolve(false);
  }
}

export function isBrowserTriggeredNavigation(source: 'imperative'|'popstate'|'hashchange') {
  return source !== 'imperative';
}